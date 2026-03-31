#!/usr/bin/env node

// Suppress Node.js experimental warnings (e.g., SQLite)
process.removeAllListeners("warning");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const origEmit = process.emit.bind(process) as (...args: any[]) => boolean;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process as any).emit = function (event: string, ...args: any[]) {
  if (event === "warning" && args[0]?.name === "ExperimentalWarning") {
    return false;
  }
  return origEmit(event, ...args);
};

import { initCommand } from "./cli/init.js";
import { syncCommand } from "./cli/sync.js";

const USAGE = `
synaptic — persistent local memory for Claude Code

Usage:
  synaptic [command] [options]

Commands:
  init          Initialize synaptic (default if no command given)
  sync          Manage GitHub-based context sync

Options:
  -h, --help    Show this help message
`.trim();

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "--help" || command === "-h") {
    console.log(USAGE);
    process.exit(0);
  }

  // Default to init --global when no command given
  if (!command || command === "init") {
    const initArgs = command === "init" ? args.slice(1) : ["--global"];
    await initCommand(initArgs);
    return;
  }

  switch (command) {
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
