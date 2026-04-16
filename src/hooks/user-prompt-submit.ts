import { detectSaveIntent } from "./lib/triggers.js";
import { saveHandoff } from "./lib/save-handoff.js";

interface UserPromptSubmitInput {
  session_id?: string;
  cwd?: string;
  prompt?: string;
  hook_event_name?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runUserPromptSubmit(): Promise<void> {
  const raw = await readStdin();
  let input: UserPromptSubmitInput = {};
  try {
    input = JSON.parse(raw || "{}");
  } catch {
    // Bad JSON from Claude Code — silently exit, never break the user's turn
    return;
  }

  const prompt = input.prompt ?? "";
  if (!prompt) return;

  const intent = detectSaveIntent(prompt);
  if (!intent.matched) return;

  const sessionId = input.session_id ?? "unknown";
  const cwd = input.cwd ?? process.cwd();
  const cwdLabel = cwd.split("/").pop() ?? "unknown";
  const sessionShort = sessionId.slice(0, 8);

  const tags: string[] = [
    intent.kind === "checkpoint-command" ? "trigger:checkpoint-cmd" : "trigger:user-prompt",
    "session:" + sessionShort,
    "cwd:" + cwdLabel,
  ];

  const name =
    intent.kind === "checkpoint-command" && intent.name
      ? intent.name
      : new Date().toISOString().slice(0, 16).replace("T", " ");

  const truncated = prompt.length > 500 ? prompt.slice(0, 500) + "…" : prompt;
  const content = [
    "**Auto-save triggered by user prompt** (" + intent.reason + ")",
    "",
    "**Name:** " + name,
    "**Session:** " + sessionId,
    "**Working dir:** " + cwd,
    "**Original prompt:** " + truncated,
  ].join("\n");

  try {
    const result = await saveHandoff({ content, tags, pinned: intent.kind === "checkpoint-command" });
    process.stdout.write("💾 Saved checkpoint: " + name + " (" + result.id + ")\n");
  } catch (err) {
    console.error("[user-prompt-submit] save failed:", err);
  }
}
