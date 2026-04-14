#!/usr/bin/env node
/*
 * Enforce that .claude-plugin/plugin.json.version matches package.json.version.
 *
 * Why this exists:
 *   Claude Code uses plugin.json.version as the cache-invalidation key for
 *   plugin installs. If plugin.json.version drifts from package.json.version,
 *   plugin-installed users get permanently frozen on whatever snapshot the
 *   plugin cache has, no matter how many npm releases ship — because their
 *   cache key never changes.
 *
 *   This script is wired into prepublishOnly so a publish CANNOT go out
 *   with the two files out of sync. It can also be run manually
 *   (`node scripts/sync-plugin-version.cjs --write` to auto-sync).
 *
 * Modes:
 *   default                 fail with a non-zero exit if the versions differ
 *   --write                 copy package.json.version into plugin.json.version
 *
 * Both files must exist at the project root. Both must be valid JSON.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PKG_PATH = path.join(PROJECT_ROOT, "package.json");
const PLUGIN_PATH = path.join(PROJECT_ROOT, ".claude-plugin", "plugin.json");

const WRITE_MODE = process.argv.includes("--write");

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function writeJSON(file, data) {
  // Preserve trailing newline if the original had one.
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function fail(msg) {
  process.stderr.write(`sync-plugin-version: ${msg}\n`);
  process.exit(1);
}

if (!fs.existsSync(PKG_PATH)) fail(`${PKG_PATH} does not exist`);
if (!fs.existsSync(PLUGIN_PATH)) fail(`${PLUGIN_PATH} does not exist`);

let pkg, plugin;
try {
  pkg = readJSON(PKG_PATH);
} catch (err) {
  fail(`failed to parse package.json: ${err.message}`);
}
try {
  plugin = readJSON(PLUGIN_PATH);
} catch (err) {
  fail(`failed to parse plugin.json: ${err.message}`);
}

if (!pkg.version) fail("package.json has no version field");
if (typeof plugin !== "object" || plugin === null)
  fail("plugin.json is not a JSON object");

if (plugin.version === pkg.version) {
  console.log(`sync-plugin-version: OK (${pkg.version})`);
  process.exit(0);
}

if (!WRITE_MODE) {
  fail(
    `version mismatch: package.json=${pkg.version}, plugin.json=${plugin.version}\n` +
      `  Run \`node scripts/sync-plugin-version.cjs --write\` to fix, or bump\n` +
      `  package.json with \`npm version <patch|minor|major>\` and re-run.\n` +
      `  Plugin-installed users get cache-frozen if these don't match.`,
  );
}

const oldVersion = plugin.version;
plugin.version = pkg.version;
writeJSON(PLUGIN_PATH, plugin);
console.log(
  `sync-plugin-version: updated plugin.json ${oldVersion} → ${pkg.version}`,
);
