#!/usr/bin/env node

import process from 'node:process';
import fs from 'node:fs';
import { validate, loadMap } from '../src/config.js';
import { figmaClient } from '../src/figma.js';
import { github } from '../src/github.js';
import { runFetch } from '../src/fetch.js';

const USAGE = `Usage: figma-sync <subcommand> [options]

Subcommands:
  validate [--repo-dir <dir>]   Validate .figma-sync/map.json and referenced files
  fetch [options]               Fetch Figma node status, renders and fills
`;

const subcommands = {
  validate: async (args) => {
    let repoDir = process.cwd();
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--repo-dir' && args[i + 1]) {
        repoDir = args[i + 1];
        i++;
      }
    }

    const result = validate(repoDir);
    if (!result.ok) {
      for (const err of result.errors) {
        console.error(err);
      }
      process.exit(1);
    }
    console.log('OK');
  },

  fetch: async (args) => {
    let repoDir = process.cwd();
    let nodeId = null;
    let changeMessage = '';
    let force = false;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--repo-dir' && args[i + 1]) {
        repoDir = args[i + 1];
        i++;
      } else if (args[i] === '--node-id' && args[i + 1]) {
        nodeId = args[i + 1];
        i++;
      } else if (args[i] === '--change-message' && args[i + 1]) {
        changeMessage = args[i + 1];
        i++;
      } else if (args[i] === '--force') {
        force = true;
      }
    }

    const figmaToken = process.env.FIGMA_TOKEN;
    const ghToken = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPOSITORY;

    if (!figmaToken) {
      console.error('FIGMA_TOKEN is required in environment');
      process.exit(1);
    }
    if (!ghToken) {
      console.error('GITHUB_TOKEN is required in environment');
      process.exit(1);
    }
    if (!repo) {
      console.error('GITHUB_REPOSITORY is required in environment');
      process.exit(1);
    }

    const map = loadMap(repoDir);
    const figma = figmaClient({ token: figmaToken });
    const gh = github({ token: ghToken, repo });

    const runUrl = `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID || ''}`;

    const res = await runFetch({
      repoDir,
      map,
      figma,
      gh,
      eventNodeId: nodeId,
      changeMessage,
      force,
      runUrl
    });

    const dueJson = JSON.stringify(res.due);
    console.log(`due=${dueJson}`);

    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `due=${dueJson}\nbase=${res.base || ''}\n`
      );
    }
  }
  // Later tasks will add: guard, prompt, shots, smoke, prepare-publish, after-publish, closed
};

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || !subcommands[command]) {
    console.error(USAGE.trim());
    process.exit(64);
  }

  try {
    await subcommands[command](args.slice(1));
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}

main();
