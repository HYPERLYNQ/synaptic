/*
 * Shared install/locate logic for the synaptic Claude Code plugin
 * launchers (mcp launcher + hook launcher). Pure CommonJS, zero external
 * dependencies (Node stdlib only).
 *
 * Exports:
 *   pluginEnv()                  → resolve & validate CLAUDE_PLUGIN_{ROOT,DATA}
 *   readPluginManifest(env)      → load plugin.json from CLAUDE_PLUGIN_ROOT
 *   isInstallCurrent(env, ver)   → true if installed.json marker matches version
 *   ensureInstalled(env, opts)   → idempotent, lockfile-protected npm install
 *   synapticCliPath(env)         → absolute path to installed synaptic CLI
 *   synapticHookEntry(env, name) → absolute path to installed hook script
 *   log(msg)                     → stderr-only logging (stdout is reserved for MCP framing)
 *
 * Race safety: ensureInstalled uses a PID-recorded lockfile so that the
 * MCP launcher and the SessionStart hook launcher can fire in parallel
 * without corrupting the install. Whichever process acquires the lock
 * first does the install; the other waits and re-checks, then proceeds.
 *
 * Update detection: the install marker is keyed on plugin.json.version.
 * Bumping the version invalidates the marker and triggers a re-install
 * on the next session. The marker is written last so a partial install
 * never looks complete.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// ── env validation ────────────────────────────────────────────────────

/**
 * Resolve and validate the plugin environment vars Claude Code provides.
 * Throws (with a clear message on stderr) if the launcher was invoked
 * outside the plugin runtime.
 */
function pluginEnv() {
  const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT;
  const PLUGIN_DATA = process.env.CLAUDE_PLUGIN_DATA;
  if (!PLUGIN_ROOT || !PLUGIN_DATA) {
    log(
      "ERROR: CLAUDE_PLUGIN_ROOT and CLAUDE_PLUGIN_DATA must be set. " +
        "This script is only meant to be invoked by Claude Code as a plugin.",
    );
    process.exit(1);
  }
  return { PLUGIN_ROOT, PLUGIN_DATA };
}

// ── logging ───────────────────────────────────────────────────────────

/**
 * Write to stderr, never stdout. The MCP launcher's stdout is reserved
 * for stdio MCP framing once it hands off to the synaptic CLI; anything
 * we emit on stdout would corrupt the protocol.
 */
function log(msg) {
  process.stderr.write(`synaptic: ${msg}\n`);
}

// ── safe file IO ──────────────────────────────────────────────────────

function readJSONSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function writeJSONAtomic(file, data) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/**
 * Best-effort directory size for diagnostic logging. Never throws.
 */
function describeSize(dir) {
  try {
    const stack = [dir];
    let total = 0;
    while (stack.length) {
      const cur = stack.pop();
      let stat;
      try {
        stat = fs.statSync(cur);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        let entries = [];
        try {
          entries = fs.readdirSync(cur);
        } catch {
          continue;
        }
        for (const e of entries) stack.push(path.join(cur, e));
      } else {
        total += stat.size;
      }
    }
    return `${(total / (1024 * 1024)).toFixed(0)} MB`;
  } catch {
    return "unknown size";
  }
}

// ── manifest + paths ──────────────────────────────────────────────────

function readPluginManifest(env) {
  return readJSONSafe(
    path.join(env.PLUGIN_ROOT, ".claude-plugin", "plugin.json"),
  );
}

function synapticCliPath(env) {
  return path.join(
    env.PLUGIN_DATA,
    "node_modules",
    "@hyperlynq",
    "synaptic",
    "build",
    "src",
    "cli.js",
  );
}

function synapticHookEntry(env, hookName) {
  return path.join(
    env.PLUGIN_DATA,
    "node_modules",
    "@hyperlynq",
    "synaptic",
    "build",
    "src",
    "hooks",
    `${hookName}.js`,
  );
}

// ── install state ─────────────────────────────────────────────────────

function installMarkerPath(env) {
  return path.join(env.PLUGIN_DATA, "installed.json");
}

function isInstallCurrent(env, expectedVersion) {
  const marker = readJSONSafe(installMarkerPath(env));
  if (!marker || marker.version !== expectedVersion) return false;
  // Defensive: also verify the actual CLI file exists. A broken install
  // (interrupted npm) wouldn't have the cli.js even if the marker did
  // somehow get written first, and a manual deletion of node_modules
  // shouldn't make a stale marker look valid.
  return fs.existsSync(synapticCliPath(env));
}

// ── lockfile ──────────────────────────────────────────────────────────

function lockFilePath(env) {
  return path.join(env.PLUGIN_DATA, ".install.lock");
}

/**
 * Acquire an exclusive install lock by atomically creating a lockfile
 * with our PID inside. If another process holds it, wait up to maxWaitMs
 * for them to finish. Stale locks (from crashed processes) are detected
 * via process.kill(pid, 0) and broken automatically.
 */
function acquireLock(env, maxWaitMs) {
  fs.mkdirSync(env.PLUGIN_DATA, { recursive: true });
  const file = lockFilePath(env);
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;

      // Lock is held. Check if the holder is still alive.
      const holderPid = parseInt(
        (() => {
          try {
            return fs.readFileSync(file, "utf-8").trim();
          } catch {
            return "0";
          }
        })(),
        10,
      );
      if (holderPid > 0) {
        let alive = true;
        try {
          process.kill(holderPid, 0);
        } catch (e) {
          if (e && e.code === "ESRCH") alive = false;
        }
        if (!alive) {
          // Stale lock — remove it and retry immediately.
          try {
            fs.unlinkSync(file);
          } catch {
            /* ignore */
          }
          continue;
        }
      }

      // Holder is alive; sleep briefly then retry.
      const sleepFor = Math.min(500, deadline - Date.now());
      if (sleepFor <= 0) return false;
      const wakeAt = Date.now() + sleepFor;
      while (Date.now() < wakeAt) {
        // Busy-wait — the inner loop runs at most ~500ms total.
      }
    }
  }
  return false;
}

function releaseLock(env) {
  try {
    fs.unlinkSync(lockFilePath(env));
  } catch {
    /* ignore */
  }
}

// ── install ───────────────────────────────────────────────────────────

/**
 * Run npm install in the plugin data dir to materialize synaptic at the
 * expected version. Caller must hold the install lock.
 */
function performInstall(env, expectedVersion) {
  fs.mkdirSync(env.PLUGIN_DATA, { recursive: true });

  // Synthetic wrapper package.json so npm has something to resolve from.
  // Pinning to the exact version means any future plugin.json bump
  // creates a new install state that this lib will detect and act on.
  //
  // Dev backdoor: SYNAPTIC_DEV_TARBALL=/path/to/tarball.tgz overrides the
  // dep with a local file install. Used by the launcher e2e test to
  // exercise this code path against an unpublished version. Production
  // users never set this — npm install behaves normally.
  const devTarball = process.env.SYNAPTIC_DEV_TARBALL;
  const synapticDep = devTarball ? `file:${devTarball}` : expectedVersion;
  const wrapperPkg = {
    name: "synaptic-plugin-host",
    version: "1.0.0",
    private: true,
    description:
      "Synthetic host package created by the synaptic Claude Code plugin launcher.",
    dependencies: {
      "@hyperlynq/synaptic": synapticDep,
    },
  };
  writeJSONAtomic(path.join(env.PLUGIN_DATA, "package.json"), wrapperPkg);

  log(
    `installing @hyperlynq/synaptic@${expectedVersion} into plugin data dir (one-time, ~30s)…`,
  );

  // Windows needs shell:true to spawn npm.cmd (CVE-2024-27980 mitigation
  // in Node 18.20.2+/20.12.2+ refuses to launch .cmd/.bat otherwise).
  // Use a single pre-built command string to avoid DEP0190 (shell + args
  // array is deprecated). Args are static literals — no injection risk.
  const isWindows = process.platform === "win32";
  const npmCmd = isWindows ? "npm.cmd" : "npm";
  const installArgs = "install --omit=dev --no-audit --no-fund";
  const result = isWindows
    ? spawnSync(`${npmCmd} ${installArgs}`, {
        cwd: env.PLUGIN_DATA,
        stdio: ["ignore", "inherit", "inherit"],
        env: process.env,
        shell: true,
      })
    : spawnSync(npmCmd, installArgs.split(" "), {
        cwd: env.PLUGIN_DATA,
        stdio: ["ignore", "inherit", "inherit"],
        env: process.env,
      });

  if (result.error) {
    log(
      `ERROR: failed to spawn npm: ${result.error.message}. ` +
        "Make sure node and npm are installed and on PATH.",
    );
    process.exit(1);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    log(
      `ERROR: npm install exited with status ${result.status}. ` +
        "Check the output above for details. " +
        "You can retry by restarting Claude Code.",
    );
    process.exit(1);
  }

  if (!fs.existsSync(synapticCliPath(env))) {
    log(
      `ERROR: install reported success but synaptic CLI was not found at ${synapticCliPath(env)}. ` +
        "The published package may be malformed.",
    );
    process.exit(1);
  }

  // Prune onnxruntime-node bloat (~493 MB) deterministically AFTER npm
  // install completes. We can't rely on synaptic's own postinstall hook
  // because npm doesn't guarantee it runs after onnxruntime-node finishes
  // downloading its GPU binaries (synaptic's postinstall would race ahead
  // and find the GPU files missing). Running it from the launcher gives
  // us full control over the ordering.
  const prunePath = path.join(
    env.PLUGIN_DATA,
    "node_modules",
    "@hyperlynq",
    "synaptic",
    "scripts",
    "prune-onnxruntime-binaries.cjs",
  );
  if (fs.existsSync(prunePath)) {
    const pruneResult = spawnSync(process.execPath, [prunePath], {
      cwd: env.PLUGIN_DATA,
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env,
    });
    if (pruneResult.error) {
      // Prune failure is non-fatal — the install is functional, just bigger.
      log(
        `warning: prune failed (${pruneResult.error.message}). Install is ${describeSize(env.PLUGIN_DATA)} (would be smaller after prune).`,
      );
    }
  }

  // Marker is written last so a partial install never looks complete.
  writeJSONAtomic(installMarkerPath(env), {
    version: expectedVersion,
    installedAt: new Date().toISOString(),
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
  });

  log(`installed @hyperlynq/synaptic@${expectedVersion}.`);
}

/**
 * Idempotent, race-safe entry point: ensure the expected version of
 * synaptic is materialized in the plugin data dir. Returns synchronously
 * once the install is current. Exits the process on any unrecoverable
 * error (with a clear stderr message Claude Code surfaces in its plugin
 * errors panel).
 *
 * @param env plugin env from pluginEnv()
 * @param opts.maxWaitMs maximum time to wait for an in-progress install
 *                      from a sibling process. Defaults to 5 minutes.
 */
function ensureInstalled(env, opts) {
  const manifest = readPluginManifest(env);
  if (!manifest || !manifest.version) {
    log(
      "ERROR: cannot read plugin.json.version from CLAUDE_PLUGIN_ROOT. " +
        "The plugin manifest is missing or malformed.",
    );
    process.exit(1);
  }
  const expectedVersion = manifest.version;
  if (isInstallCurrent(env, expectedVersion)) return expectedVersion;

  const maxWaitMs = (opts && opts.maxWaitMs) || 5 * 60 * 1000;
  if (!acquireLock(env, maxWaitMs)) {
    log(
      `ERROR: could not acquire install lock within ${Math.round(maxWaitMs / 1000)}s. ` +
        `If a previous install crashed, delete ${lockFilePath(env)} and try again.`,
    );
    process.exit(1);
  }

  try {
    // Re-check after acquiring the lock: a sibling process may have
    // installed it while we were waiting.
    if (isInstallCurrent(env, expectedVersion)) return expectedVersion;
    performInstall(env, expectedVersion);
  } finally {
    releaseLock(env);
  }
  return expectedVersion;
}

module.exports = {
  pluginEnv,
  log,
  readPluginManifest,
  synapticCliPath,
  synapticHookEntry,
  isInstallCurrent,
  ensureInstalled,
};
