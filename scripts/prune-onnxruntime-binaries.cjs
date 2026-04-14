#!/usr/bin/env node
/*
 * Prune unused onnxruntime-node binaries.
 *
 * onnxruntime-node has a postinstall script that downloads ~370 MB of
 * platform+GPU binaries from GitHub releases. On the typical install:
 *
 *   - The CUDA provider library (~327 MB) is the bulk of the download.
 *   - 5 of 6 platform/arch directories are dead weight (synaptic only
 *     runs on the install platform).
 *   - The CUDA + TensorRT GPU providers are dead weight regardless: the
 *     synaptic embedder uses Xenova/all-MiniLM-L6-v2 with q8 quantization,
 *     which is CPU-only. Quantized models don't have GPU code paths in
 *     onnxruntime, so the CUDA library is literally never loaded.
 *
 * After the prune, the install drops from ~732 MB to ~239 MB with zero
 * functional impact on synaptic.
 *
 * IMPORTANT: this script must run AFTER onnxruntime-node's own postinstall
 * has finished downloading its binaries. npm doesn't give synaptic a
 * lifecycle hook with that ordering guarantee, so the prune is invoked
 * deterministically from two well-defined points instead:
 *
 *   1. The plugin launcher (.claude-plugin/launcher.cjs) calls the script
 *      after `npm install` returns successfully when bootstrapping the
 *      install into ${CLAUDE_PLUGIN_DATA}.
 *   2. `synaptic init` calls the script (with --quiet) at the end of the
 *      legacy `npm install -g @hyperlynq/synaptic && synaptic init` flow.
 *
 * Users can also run it manually:
 *   synaptic prune
 *
 * Opt-out env vars (set either or both):
 *   SYNAPTIC_KEEP_GPU=1            keep CUDA + TensorRT providers
 *   SYNAPTIC_KEEP_ALL_PLATFORMS=1  keep binaries for every platform
 *
 * The script is defensive and idempotent: it skips silently if onnxruntime
 * isn't present, if files are missing, or if it's run a second time.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const KEEP_GPU = process.env.SYNAPTIC_KEEP_GPU === "1";
const KEEP_ALL_PLATFORMS = process.env.SYNAPTIC_KEEP_ALL_PLATFORMS === "1";

// Locate onnxruntime-node via Node's module resolution. This respects
// npm's hoisting, pnpm's symlinked layout, yarn's flat layout, and any
// other layout where a sibling package can reach onnxruntime via require.
// It also makes the script safe to invoke manually: if onnxruntime can't
// be resolved from this script's location, we no-op rather than walking
// into an unrelated node_modules tree.
function findOnnxRoot() {
  try {
    const pkgJson = require.resolve("onnxruntime-node/package.json");
    return path.dirname(pkgJson);
  } catch {
    return null;
  }
}

function safeRm(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function bytesToMB(n) {
  return (n / (1024 * 1024)).toFixed(1);
}

function dirSize(target) {
  let total = 0;
  if (!fs.existsSync(target)) return 0;
  const stack = [target];
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
      for (const entry of entries) stack.push(path.join(cur, entry));
    } else {
      total += stat.size;
    }
  }
  return total;
}

function main() {
  const onnxRoot = findOnnxRoot();
  if (!onnxRoot) {
    // onnxruntime not installed — nothing to do.
    return;
  }

  const napiDir = path.join(onnxRoot, "bin", "napi-v3");
  if (!fs.existsSync(napiDir)) {
    // Unexpected layout — bail out silently.
    return;
  }

  const before = dirSize(onnxRoot);
  let removed = 0;

  // 1. Prune other-platform directories.
  if (!KEEP_ALL_PLATFORMS) {
    const wantPlatform = process.platform; // "linux", "darwin", "win32"
    const wantArch = process.arch; // "x64", "arm64", ...

    let platforms = [];
    try {
      platforms = fs.readdirSync(napiDir);
    } catch {
      // empty
    }

    for (const platform of platforms) {
      const platformDir = path.join(napiDir, platform);
      if (platform !== wantPlatform) {
        if (safeRm(platformDir)) removed++;
        continue;
      }
      // Keep the current platform but prune other architectures inside it.
      let archs = [];
      try {
        archs = fs.readdirSync(platformDir);
      } catch {
        continue;
      }
      for (const arch of archs) {
        if (arch === wantArch) continue;
        if (safeRm(path.join(platformDir, arch))) removed++;
      }
    }
  }

  // 2. Prune GPU providers from the current platform/arch.
  if (!KEEP_GPU) {
    const archDir = path.join(napiDir, process.platform, process.arch);
    const gpuLibs = [
      // Linux GPU providers
      "libonnxruntime_providers_cuda.so",
      "libonnxruntime_providers_tensorrt.so",
      // Windows GPU providers
      "onnxruntime_providers_cuda.dll",
      "onnxruntime_providers_tensorrt.dll",
      "DirectML.dll",
      // macOS GPU providers (CoreML lives here on darwin builds)
      "libonnxruntime_providers_coreml.dylib",
    ];
    for (const lib of gpuLibs) {
      const target = path.join(archDir, lib);
      if (fs.existsSync(target)) {
        try {
          fs.unlinkSync(target);
          removed++;
        } catch {
          // ignore
        }
      }
    }
  }

  if (removed === 0) {
    // Already pruned — nothing to report.
    return;
  }

  const after = dirSize(onnxRoot);
  const saved = before - after;
  // Single concise line; the user is in the middle of an `npm install` and
  // doesn't need a wall of text.
  process.stderr.write(
    `synaptic: pruned ${removed} unused onnxruntime artifact(s), saved ${bytesToMB(saved)} MB ` +
      `(${bytesToMB(before)} → ${bytesToMB(after)} MB).\n`,
  );
}

try {
  main();
} catch (err) {
  // Never fail npm install because of pruning.
  process.stderr.write(
    `synaptic: prune skipped (${err && err.message ? err.message : err}).\n`,
  );
}
