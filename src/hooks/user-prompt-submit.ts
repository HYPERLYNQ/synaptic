import { detectSaveIntent } from "./lib/triggers.js";
import { saveCheckpoint } from "./lib/save-checkpoint.js";
import { detectProjectRoot } from "../lib/project-root.js";

interface UserPromptSubmitInput {
  session_id?: string;
  cwd?: string;
  prompt?: string;
  hook_event_name?: string;
}

async function readStdin(stdin: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.from(chunk as Buffer | string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function slugifyName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

export async function runUserPromptSubmit(stdin: AsyncIterable<unknown> = process.stdin): Promise<void> {
  const raw = await readStdin(stdin);
  let input: UserPromptSubmitInput = {};
  try { input = JSON.parse(raw || "{}"); } catch { return; }

  const prompt = input.prompt ?? "";
  if (!prompt) return;

  const intent = detectSaveIntent(prompt);
  if (!intent.matched) return;

  const cwd = input.cwd ?? process.cwd();
  const projectRoot = detectProjectRoot(cwd);
  const sessionShort = (input.session_id ?? "unknown").slice(0, 8);

  const name =
    intent.kind === "checkpoint-command" && intent.name
      ? slugifyName(intent.name)
      : "user-intent-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  const summary =
    intent.kind === "checkpoint-command" && intent.name
      ? "User checkpoint: " + intent.name
      : "User-requested checkpoint";

  const truncated = prompt.length > 500 ? prompt.slice(0, 500) + "…" : prompt;
  const content = [
    "**Auto-checkpoint triggered by user prompt** (" + intent.reason + ")",
    "",
    "**Name:** " + name,
    "**Session:** " + (input.session_id ?? "unknown"),
    "**Working dir:** " + cwd,
    "**Original prompt:** " + truncated,
  ].join("\n");

  const tags = [
    intent.kind === "checkpoint-command" ? "trigger:checkpoint-cmd" : "trigger:user-prompt",
    "session:" + sessionShort,
    "cwd:" + (cwd.split("/").pop() ?? "unknown"),
  ];

  try {
    const result = await saveCheckpoint({ name, summary, content, tags, projectRoot });
    process.stdout.write("💾 Saved checkpoint: " + name + " (" + result.id + ")\n");
  } catch (err) {
    console.error("[user-prompt-submit] save failed:", err);
  }
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runUserPromptSubmit().catch((err) => {
    console.error("[user-prompt-submit] fatal:", err);
    process.exit(1);
  });
}
