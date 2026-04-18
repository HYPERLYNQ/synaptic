#!/usr/bin/env node

// MUST be the first import: exits early if a Windows-installed synaptic
// is being executed under WSL (before any native-binding import crashes).
import "./lib/platform-guard.js";

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
import { cleanupCommand } from "./cli/cleanup.js";

const USAGE = `
synaptic — persistent local memory for Claude Code

Usage:
  synaptic [command] [options]

Commands:
  init                       Initialize synaptic (default if no command given)
  serve                      Start the MCP server (used by Claude Code plugin system)
  hook <name>                Run a lifecycle hook (session-start | pre-compact | stop | user-prompt-submit | post-tool-use)
  prune                      Prune unused onnxruntime binaries (saves ~493 MB)
  sync                       Manage GitHub-based context sync
  cleanup                    Smart duplicate detection and cleanup

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
    case "serve": {
      // Start the MCP server — used by the plugin system's .mcp.json
      const { createServer, getEmbedder, startBackgroundServices } = await import("./server.js");
      const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
      const server = createServer();
      const transport = new StdioServerTransport();
      await server.connect(transport);
      startBackgroundServices();
      getEmbedder().warmup().catch(() => {});
      break;
    }
    case "hook": {
      // Run a lifecycle hook by name — used by the plugin system's
      // hook-launcher to dispatch hook events into synaptic without spawning
      // separate node processes per hook script.
      const hookName = args[1];
      if (!hookName) {
        console.error("Usage: synaptic hook <session-start|pre-compact|stop|user-prompt-submit|post-tool-use>");
        process.exit(1);
      }
      switch (hookName) {
        case "session-start": {
          const { runSessionStart } = await import("./hooks/session-start.js");
          await runSessionStart();
          break;
        }
        case "pre-compact": {
          const { runPreCompact } = await import("./hooks/pre-compact.js");
          await runPreCompact();
          break;
        }
        case "stop": {
          const { runStop } = await import("./hooks/stop.js");
          await runStop();
          break;
        }
        case "user-prompt-submit": {
          const { runUserPromptSubmit } = await import("./hooks/user-prompt-submit.js");
          await runUserPromptSubmit();
          break;
        }
        case "post-tool-use": {
          const { runPostToolUse } = await import("./hooks/post-tool-use.js");
          await runPostToolUse();
          break;
        }
        default:
          console.error(`Unknown hook: ${hookName}`);
          console.error("Valid hooks: session-start, pre-compact, stop, user-prompt-submit, post-tool-use");
          process.exit(1);
      }
      break;
    }
    case "prune": {
      // Run the onnxruntime prune script. We use spawnSync to a child node
      // process rather than `import("...")` because the script is CJS and
      // the synaptic CLI is ESM — mixing the two via dynamic import is
      // possible but the spawn boundary keeps behavior identical to npm
      // postinstall and the launcher install path.
      const { spawnSync } = await import("node:child_process");
      const { fileURLToPath } = await import("node:url");
      const { dirname, join } = await import("node:path");
      // build/src/cli.js → ../scripts/prune-onnxruntime-binaries.cjs
      // (npm install lands the script at <pkg>/scripts/prune-onnxruntime-binaries.cjs)
      const here = dirname(fileURLToPath(import.meta.url));
      const prunePath = join(here, "..", "..", "scripts", "prune-onnxruntime-binaries.cjs");
      const result = spawnSync(process.execPath, [prunePath], {
        stdio: "inherit",
      });
      process.exit(typeof result.status === "number" ? result.status : 0);
    }
    case "sync":
      await syncCommand(args.slice(1));
      break;
    case "cleanup":
      await cleanupCommand(args.slice(1));
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
