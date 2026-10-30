#!/usr/bin/env node

import process from 'node:process';
import { validate } from '../src/config.js';

const USAGE = `Usage: figma-sync <subcommand> [options]

Subcommands:
  validate [--repo-dir <dir>]   Validate .figma-sync/map.json and referenced files
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
  }
  // Later tasks will add: fetch, guard, prompt, shots, smoke, prepare-publish, after-publish, closed
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
