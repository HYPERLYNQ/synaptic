/*
 * Platform-mismatch guard: if a Windows-installed synaptic is executed
 * under WSL (Windows filesystem path, linux Node runtime), native deps
 * like sharp and onnxruntime-node crash with "Could not load the X
 * module using the linux-x64 runtime" before any of our code runs.
 *
 * This module has zero imports so its top-level check runs before any
 * native-binding-loading import in cli.ts / server.ts. Imported for side
 * effects only: `import "./lib/platform-guard.js";`
 */

if (process.platform === "linux") {
  const script = process.argv[1] || "";
  if (/^\/mnt\/[a-z]\//i.test(script)) {
    process.stderr.write(
      "synaptic: detected Windows install running under WSL.\n" +
        "  Script: " +
        script +
        "\n" +
        "  Native dependencies (sharp, onnxruntime-node) are compiled for win32\n" +
        "  and cannot run on linux. Install synaptic inside WSL instead:\n" +
        "    npm install -g @hyperlynq/synaptic\n",
    );
    process.exit(1);
  }
}

export {};
