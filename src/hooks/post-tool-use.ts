import { classifyToolEvent } from "./lib/tool-events.js";
import { saveCheckpoint } from "./lib/save-checkpoint.js";
import { detectProjectRoot } from "../lib/project-root.js";

interface PostToolUseInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  hook_event_name?: string;
}

async function readStdin(stream: AsyncIterable<unknown> = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as ArrayBufferLike));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runPostToolUse(stdin?: AsyncIterable<unknown>): Promise<void> {
  const raw = await readStdin(stdin);
  let input: PostToolUseInput = {};
  try { input = JSON.parse(raw || "{}"); } catch { return; }
  if (!input.tool_name) return;

  const classified = classifyToolEvent({
    tool_name: input.tool_name,
    tool_input: input.tool_input ?? {},
    tool_response: input.tool_response ?? {},
  });
  if (!classified) return;

  const cwd = input.cwd ?? process.cwd();
  const projectRoot = detectProjectRoot(cwd);
  const sessionShort = (input.session_id ?? "unknown").slice(0, 8);

  const content = [
    "**Auto-checkpoint triggered by tool use** (" + classified.kind + ")",
    "",
    "**Summary:** " + classified.summary,
    "**Session:** " + (input.session_id ?? "unknown"),
    "**Working dir:** " + cwd,
  ].join("\n");

  const tags = [
    ...classified.tags,
    classified.dedupeKey,
    "session:" + sessionShort,
    "cwd:" + (cwd.split("/").pop() ?? "unknown"),
  ];

  try {
    await saveCheckpoint({
      name: classified.name,
      summary: classified.summary,
      content,
      tags,
      projectRoot,
      sessionId: input.session_id,
      agentId: "post-tool-use",
    });
  } catch (err) {
    console.error("[post-tool-use] save failed:", err);
  }
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPostToolUse().catch((err) => {
    console.error("[post-tool-use] fatal:", err);
    process.exit(1);
  });
}
