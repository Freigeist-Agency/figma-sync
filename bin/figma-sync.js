#!/usr/bin/env node

import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { validate, loadMap } from '../src/config.js';
import { figmaClient } from '../src/figma.js';
import { github } from '../src/github.js';
import { runFetch } from '../src/fetch.js';
import { runGuard } from '../src/guard.js';
import { writeSectionPrompt } from '../src/prompt.js';
import { shootSections, smoke } from '../src/shots.js';
import { preparePublish, afterPublish } from '../src/publish.js';
import { runClosed } from '../src/close.js';

const USAGE = `Usage: figma-sync <subcommand> [options]

Subcommands:
  validate [--repo-dir <dir>]            Validate .figma-sync/map.json and referenced files
  fetch [options]                        Fetch Figma node status, renders and fills
  guard --base <sha> --section <name>    Verify no protected files were modified
  prompt --section <name>                Generate Claude prompt for a section
  shots [--repo-dir <dir>]               Capture section screenshots at 3 widths
  smoke [--repo-dir <dir>] [--base <sha>] Run smoke checks and map checks
  prepare-publish --base <sha> --work-ref <ref> Prepare PR body and sync state
  after-publish --pr <n>                 Add dev resources to Figma frames
  closed --pr <n> --merged <bool> --base-sha <sha> --head-sha <sha> Handle PR closure
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
  },

  guard: async (args) => {
    let repoDir = process.cwd();
    let base = null;
    let sectionName = null;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--repo-dir' && args[i + 1]) {
        repoDir = args[i + 1];
        i++;
      } else if (args[i] === '--base' && args[i + 1]) {
        base = args[i + 1];
        i++;
      } else if (args[i] === '--section' && args[i + 1]) {
        sectionName = args[i + 1];
        i++;
      }
    }

    if (!base) {
      console.error('--base <sha> is required');
      process.exit(1);
    }
    if (!sectionName) {
      console.error('--section <name> is required');
      process.exit(1);
    }

    const map = loadMap(repoDir);
    const figmaToken = process.env.FIGMA_TOKEN;
    const figma = figmaToken ? figmaClient({ token: figmaToken }) : null;

    const violations = await runGuard({
      repoDir,
      base,
      sectionName,
      map,
      figma
    });

    if (violations.length > 0) {
      console.error(`Sync stopped: it changed protected files: ${violations.join(', ')}`);
      process.exit(1);
    }
  },

  prompt: async (args) => {
    let repoDir = process.cwd();
    let sectionName = null;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--repo-dir' && args[i + 1]) {
        repoDir = args[i + 1];
        i++;
      } else if (args[i] === '--section' && args[i + 1]) {
        sectionName = args[i + 1];
        i++;
      }
    }

    if (!sectionName) {
      console.error('--section <name> is required');
      process.exit(1);
    }

    const map = loadMap(repoDir);
    const writtenPath = writeSectionPrompt(repoDir, map, sectionName);
    console.log(writtenPath);
  },

  shots: async (args) => {
    let repoDir = process.cwd();
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--repo-dir' && args[i + 1]) {
        repoDir = args[i + 1];
        i++;
      }
    }

    const workDir = path.join(repoDir, '.figma-sync', 'work');
    const runJsonPath = path.join(workDir, 'run.json');
    if (!fs.existsSync(runJsonPath)) {
      console.error('run.json not found in .figma-sync/work');
      process.exit(1);
    }

    const runData = JSON.parse(fs.readFileSync(runJsonPath, 'utf8'));
    const map = loadMap(repoDir);

    const dueNames = new Set((runData.due || []).map((d) => (typeof d === 'string' ? d : d.name)));
    const sectionsToShoot = (map.sections || []).filter((s) => dueNames.has(s.name));

    const outDir = path.join(workDir, 'shots');
    const shotsList = await shootSections({
      repoDir,
      sections: sectionsToShoot,
      outDir
    });

    fs.writeFileSync(path.join(workDir, 'shots.json'), JSON.stringify(shotsList, null, 2));
    console.log(`Captured ${shotsList.length} shots`);
  },

  smoke: async (args) => {
    let repoDir = process.cwd();
    let base = null;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--repo-dir' && args[i + 1]) {
        repoDir = args[i + 1];
        i++;
      } else if (args[i] === '--base' && args[i + 1]) {
        base = args[i + 1];
        i++;
      }
    }

    const map = loadMap(repoDir);
    const pagesSet = new Set();
    for (const section of map.sections || []) {
      if (section.page) {
        pagesSet.add(section.page);
      }
    }

    let diffProblem = null;
    if (base) {
      try {
        const diffOutput = execSync(`git diff --name-only ${base}`, {
          cwd: repoDir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        });
        for (const line of diffOutput.split('\n')) {
          const file = line.trim();
          if (file.endsWith('.html') && fs.existsSync(path.join(repoDir, file))) {
            pagesSet.add(file);
          }
        }
      } catch (err) {
        // Say so rather than quietly smoke-testing fewer pages.
        diffProblem = `could not list changed pages against ${base}: ${err.message}`;
      }
    }

    const pages = Array.from(pagesSet);
    const smokeResult = await smoke({ repoDir, pages });
    const problems = [...smokeResult.problems];
    if (diffProblem) problems.push(diffProblem);

    if (map.checks && typeof map.checks === 'string') {
      try {
        execSync(map.checks, {
          cwd: repoDir,
          shell: '/bin/sh',
          stdio: 'pipe'
        });
      } catch (err) {
        const stderr = err.stderr ? err.stderr.toString() : '';
        const stdout = err.stdout ? err.stdout.toString() : '';
        const msg = (stderr || stdout || err.message).trim();
        problems.push(`checks failed (${map.checks}): ${msg}`);
      }
    }

    const checksResult = {
      ok: problems.length === 0,
      problems
    };

    const workDir = path.join(repoDir, '.figma-sync', 'work');
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, 'checks.json'), JSON.stringify(checksResult, null, 2));

    if (checksResult.ok) {
      console.log('Smoke & checks passed');
    } else {
      console.log(`Smoke & checks completed with ${problems.length} problem(s)`);
    }
  },

  'prepare-publish': async (args) => {
    let repoDir = process.cwd();
    let base = null;
    let workRef = null;
    let dryRun = false;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--repo-dir' && args[i + 1]) {
        repoDir = args[i + 1];
        i++;
      } else if (args[i] === '--base' && args[i + 1]) {
        base = args[i + 1];
        i++;
      } else if (args[i] === '--work-ref' && args[i + 1]) {
        workRef = args[i + 1];
        i++;
      } else if (args[i] === '--dry-run') {
        dryRun = true;
      }
    }

    if (!base) {
      console.error('--base <sha> is required');
      process.exit(1);
    }
    if (!workRef) {
      console.error('--work-ref <ref> is required');
      process.exit(1);
    }

    const map = loadMap(repoDir);
    const figmaToken = process.env.FIGMA_TOKEN;
    const figma = figmaToken ? figmaClient({ token: figmaToken }) : null;
    const repo = process.env.GITHUB_REPOSITORY;
    const runId = process.env.GITHUB_RUN_ID;

    const res = await preparePublish({
      repoDir,
      base,
      workRef,
      map,
      figma,
      repo,
      runId,
      dryRun
    });

    if (res.skip) {
      console.log('skip=true');
    } else {
      console.log(`title=${res.title}`);
      if (dryRun) {
        console.log(`pr-body=${res.prBodyPath || path.join(repoDir, '.figma-sync', 'work', 'pr-body.md')}`);
      } else {
        console.log('skip=false');
      }
    }
  },

  'after-publish': async (args) => {
    let repoDir = process.cwd();
    let pr = null;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--repo-dir' && args[i + 1]) {
        repoDir = args[i + 1];
        i++;
      } else if (args[i] === '--pr' && args[i + 1]) {
        pr = args[i + 1];
        i++;
      }
    }

    if (!pr) {
      console.error('--pr <n> is required');
      process.exit(1);
    }

    const figmaToken = process.env.FIGMA_TOKEN;
    const repo = process.env.GITHUB_REPOSITORY;

    if (!figmaToken) {
      console.error('FIGMA_TOKEN is required in environment');
      process.exit(1);
    }
    if (!repo) {
      console.error('GITHUB_REPOSITORY is required in environment');
      process.exit(1);
    }

    const map = loadMap(repoDir);
    const figma = figmaClient({ token: figmaToken });

    await afterPublish({
      repoDir,
      prNumber: pr,
      map,
      figma,
      repo
    });

    console.log(`Linked PR #${pr} to Figma`);
  },

  closed: async (args) => {
    let repoDir = process.cwd();
    let pr = null;
    let merged = null;
    let baseSha = null;
    let headSha = null;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--repo-dir' && args[i + 1]) {
        repoDir = args[i + 1];
        i++;
      } else if (args[i] === '--pr' && args[i + 1]) {
        pr = args[i + 1];
        i++;
      } else if (args[i] === '--merged' && args[i + 1]) {
        merged = args[i + 1];
        i++;
      } else if (args[i] === '--base-sha' && args[i + 1]) {
        baseSha = args[i + 1];
        i++;
      } else if (args[i] === '--head-sha' && args[i + 1]) {
        headSha = args[i + 1];
        i++;
      }
    }

    if (!pr) {
      console.error('--pr <n> is required');
      process.exit(1);
    }
    if (merged === null) {
      console.error('--merged true|false is required');
      process.exit(1);
    }
    if (!baseSha) {
      console.error('--base-sha <sha> is required');
      process.exit(1);
    }
    if (!headSha) {
      console.error('--head-sha <sha> is required');
      process.exit(1);
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

    const res = await runClosed({
      pr: {
        number: pr,
        merged: merged === 'true' || merged === true,
        baseSha,
        headSha
      },
      gh,
      figma,
      map
    });

    console.log(`Handled closure for PR #${pr} (merged: ${res.merged}, synced sections: ${res.syncedSections.join(', ')})`);
  }
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
