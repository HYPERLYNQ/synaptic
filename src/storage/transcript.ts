/**
 * Transcript reading module for automatic context capture.
 * Reads Claude Code JSONL transcript files incrementally.
 * No embedder/database dependencies — pure file I/O.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { homedir } from "node:os";
import { DB_DIR } from "./paths.js";

const CURSOR_FILE = join(DB_DIR, ".transcript-cursor");

export interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
}

interface CursorData {
  file: string;
  offset: number;
}

/**
 * Convert a cwd path to a Claude project directory path.
 * `/home/user/project` → `~/.claude/projects/-home-user-project/`
 */
export function findClaudeProjectDir(cwd?: string): string | null {
  const dir = cwd ?? process.cwd();
  // Claude encodes the path by replacing separators with dashes
  const encoded = dir.replace(/^\//, "").replaceAll(sep === "\\" ? /[\\/]/g : /\//g, "-");
  const projectDir = join(homedir(), ".claude", "projects", `-${encoded}`);
  if (existsSync(projectDir)) return projectDir;
  return null;
}

/**
 * Find the most recently modified .jsonl transcript in the project dir.
 */
export function findCurrentTranscript(cwd?: string): string | null {
  const projectDir = findClaudeProjectDir(cwd);
  if (!projectDir) return null;

  let newest: { path: string; mtime: number } | null = null;

  for (const file of readdirSync(projectDir)) {
    if (!file.endsWith(".jsonl")) continue;
    const fullPath = join(projectDir, file);
    try {
      const st = statSync(fullPath);
      if (!newest || st.mtimeMs > newest.mtime) {
        newest = { path: fullPath, mtime: st.mtimeMs };
      }
    } catch {
      // skip unreadable files
    }
  }

  return newest?.path ?? null;
}

/**
 * Read the cursor for incremental transcript scanning.
 */
export function readCursor(): CursorData | null {
  if (!existsSync(CURSOR_FILE)) return null;
  try {
    const raw = readFileSync(CURSOR_FILE, "utf-8").trim();
    const data = JSON.parse(raw) as CursorData;
    if (typeof data.file === "string" && typeof data.offset === "number") {
      return data;
    }
  } catch {
    // corrupt cursor
  }
  return null;
}

/**
 * Write the cursor for incremental transcript scanning.
 */
export function writeCursor(cursor: CursorData): void {
  writeFileSync(CURSOR_FILE, JSON.stringify(cursor), "utf-8");
}

/**
 * Extract plain text from message content.
 * Handles string content and array content (text blocks only).
 * Skips tool_use, tool_result, and thinking blocks.
 */
export function extractTextContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content.trim() || null;
  }
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (typeof block === "object" && block !== null) {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          const trimmed = b.text.trim();
          if (trimmed) textParts.push(trimmed);
        }
      }
    }
    return textParts.length > 0 ? textParts.join("\n") : null;
  }
  return null;
}

/**
 * Read new messages from a JSONL transcript file starting at a byte offset.
 * Filters to user (string content only) and assistant (text blocks only).
 * Skips messages < 20 chars.
 */
export function readNewMessages(
  filePath: string,
  byteOffset: number
): { messages: TranscriptMessage[]; newOffset: number } {
  const messages: TranscriptMessage[] = [];

  let buf: Buffer;
  try {
    buf = readFileSync(filePath);
  } catch {
    return { messages, newOffset: byteOffset };
  }

  if (byteOffset >= buf.length) {
    return { messages, newOffset: buf.length };
  }

  const chunk = buf.subarray(byteOffset).toString("utf-8");
  const lines = chunk.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const msgType = parsed.type;

    if (msgType === "user") {
      const message = parsed.message as Record<string, unknown> | undefined;
      if (!message) continue;
      const content = message.content;
      // Only string content for user messages (skip tool_result arrays)
      if (typeof content !== "string") continue;
      const text = content.trim();
      if (text.length < 20) continue;
      messages.push({ role: "user", text });
    } else if (msgType === "assistant") {
      const message = parsed.message as Record<string, unknown> | undefined;
      if (!message) continue;
      const content = message.content;
      // Extract text blocks only (skip tool_use, thinking)
      const text = extractTextContent(content);
      if (!text || text.length < 20) continue;
      messages.push({ role: "assistant", text });
    }
  }

  return { messages, newOffset: buf.length };
}
