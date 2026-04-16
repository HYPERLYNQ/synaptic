import { classifyToolEvent } from "./lib/tool-events.js";
import { saveHandoff } from "./lib/save-handoff.js";

interface PostToolUseInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  hook_event_name?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runPostToolUse(): Promise<void> {
  const raw = await readStdin();
  let input: PostToolUseInput = {};
  try {
    input = JSON.parse(raw || "{}");
  } catch {
    return;
  }

  if (!input.tool_name) return;

  const classified = classifyToolEvent({
    tool_name: input.tool_name,
    tool_input: input.tool_input ?? {},
    tool_response: input.tool_response ?? {},
  });
  if (!classified) return;

  const sessionId = input.session_id ?? "unknown";
  const cwd = input.cwd ?? process.cwd();
  const cwdLabel = cwd.split("/").pop() ?? "unknown";
  const sessionShort = sessionId.slice(0, 8);

  const tags = [
    ...classified.tags,
    "session:" + sessionShort,
    "cwd:" + cwdLabel,
  ];

  const content = [
    "**Auto-save triggered by tool use** (" + classified.kind + ")",
    "",
    "**Summary:** " + classified.summary,
    "**Session:** " + sessionId,
    "**Working dir:** " + cwd,
  ].join("\n");

  try {
    await saveHandoff({ content, tags, pinned: false });
  } catch (err) {
    console.error("[post-tool-use] save failed:", err);
  }
}
