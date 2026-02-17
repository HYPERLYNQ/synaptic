#!/usr/bin/env node

import { initCommand } from "./cli/init.js";
import { syncCommand } from "./cli/sync.js";

const USAGE = `
synaptic — persistent local memory for Claude Code

Usage:
  synaptic <command> [options]

Commands:
  init          Initialize synaptic in the current project
  sync          Manage GitHub-based context sync

Options:
  -h, --help    Show this help message
`.trim();

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    process.exit(0);
  }

  switch (command) {
    case "init":
      await initCommand(args.slice(1));
      break;
    case "sync":
      await syncCommand(args.slice(1));
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error(`Run 'synaptic --help' for usage information.`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
