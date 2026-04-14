#!/usr/bin/env node
/*
 * Synaptic MCP server launcher (Pattern D).
 *
 * Synaptic is too heavy to ship via the Claude Code plugin cache (~239 MB
 * after onnxruntime pruning, with platform-specific native bindings). This
 * launcher installs synaptic into the persistent ${CLAUDE_PLUGIN_DATA}
 * directory on first run, then hands off to its CLI's `serve` subcommand,
 * which starts the actual MCP server over stdio. Subsequent sessions skip
 * the install and start in milliseconds.
 *
 * The install is race-safe with the SessionStart hook-launcher via a
 * lockfile (see lib.cjs). Whichever process fires first does the install;
 * the other waits and re-checks.
 *
 * Stdout is reserved for MCP framing once we hand off — every diagnostic
 * here goes to stderr, which Claude Code surfaces in the plugin errors
 * panel on failure.
 */

"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const lib = require("./lib.cjs");

const env = lib.pluginEnv();
lib.ensureInstalled(env);

// Hand off to the installed synaptic CLI's `serve` command. We use
// spawnSync with inherited stdio so the child process owns the launcher's
// stdin/stdout/stderr — this means the MCP stdio protocol flows through
// to Claude Code without any framing or buffering shim.
const cliPath = lib.synapticCliPath(env);
const result = spawnSync(
  process.execPath,
  ["--no-warnings", cliPath, "serve"],
  { stdio: "inherit", env: process.env },
);

if (result.error) {
  lib.log(`ERROR: failed to start synaptic serve: ${result.error.message}`);
  process.exit(1);
}
process.exit(typeof result.status === "number" ? result.status : 0);
