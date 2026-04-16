#!/usr/bin/env node
/*
 * Synaptic hook launcher (Pattern D).
 *
 * Dispatches Claude Code lifecycle hook events into the installed synaptic
 * CLI's `hook <name>` subcommand. Like the MCP launcher, this script lives
 * in the plugin cache (small, fast to copy) and runs synaptic from the
 * persistent ${CLAUDE_PLUGIN_DATA} install (heavy, persists across plugin
 * updates).
 *
 * Synaptic's hook scripts read JSON payloads from stdin. We use spawnSync
 * with `stdio: "inherit"` so the hook payload flows through unchanged.
 *
 * If synaptic isn't installed yet (e.g. the very first SessionStart fires
 * before the MCP launcher has finished bootstrapping), this launcher
 * triggers the install via the same shared lib + lockfile machinery as
 * the MCP launcher. Whichever process fires first does the install; the
 * other waits.
 *
 * Hook timeouts are configured in plugin.json. The wait-for-install path
 * is bounded: we cap at 4 minutes (giving ~30s of slack inside Claude
 * Code's typical 5-minute hook timeout ceiling) so a hung lock can never
 * stall a hook indefinitely.
 *
 * Usage (called by Claude Code via plugin.json hooks):
 *   node ${CLAUDE_PLUGIN_ROOT}/.claude-plugin/hook-launcher.cjs <hook-name>
 */

"use strict";

const { spawnSync } = require("node:child_process");
const lib = require("./lib.cjs");

const VALID_HOOKS = new Set([
  "session-start",
  "pre-compact",
  "stop",
  "user-prompt-submit",
  "post-tool-use",
]);

const hookName = process.argv[2];
if (!hookName) {
  lib.log("ERROR: hook name argument is required.");
  process.exit(1);
}
if (!VALID_HOOKS.has(hookName)) {
  lib.log(
    `ERROR: unknown hook "${hookName}". Valid: ${[...VALID_HOOKS].join(", ")}.`,
  );
  process.exit(1);
}

const env = lib.pluginEnv();

// Bound the install wait at 4 minutes so we can't run past Claude Code's
// per-hook timeout ceiling. If the MCP launcher is in the middle of a
// genuine first-run install, this gives us plenty of slack to wait it out.
lib.ensureInstalled(env, { maxWaitMs: 4 * 60 * 1000 });

// Hand off to `synaptic hook <name>`. spawnSync with inherited stdio means
// the hook payload (JSON on stdin) and any synaptic output flow through
// transparently to Claude Code.
const cliPath = lib.synapticCliPath(env);
const result = spawnSync(
  process.execPath,
  ["--no-warnings", cliPath, "hook", hookName],
  { stdio: "inherit", env: process.env },
);

if (result.error) {
  lib.log(
    `ERROR: failed to spawn synaptic hook ${hookName}: ${result.error.message}`,
  );
  // Hooks should never crash a session — exit 0 even on launcher errors
  // so Claude Code treats this as a no-op rather than a hard failure.
  process.exit(0);
}
// Propagate the hook's exit status. Synaptic's individual hooks already
// use exit 0 even on internal errors (see pre-compact.ts, stop.ts), so a
// non-zero status here would only come from a true infrastructure
// failure (e.g. the installed cli.js missing or malformed). In that case
// we still want Claude Code to see the failure rather than swallow it.
process.exit(typeof result.status === "number" ? result.status : 0);
