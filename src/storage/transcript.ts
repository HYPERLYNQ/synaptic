/**
 * Transcript reading module for automatic context capture.
 * Reads Claude Code JSONL transcript files incrementally.
 * No embedder/database dependencies — pure file I/O.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import { join, sep } from "node:path";
import { homedir } from "node:os";
import { DB_DIR } from "./paths.js";

/** Max transcript bytes to read at once (10 MB). Prevents OOM on huge sessions. */
const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024;

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
 *
 * When running inside WSL from a Windows Claude session (hooks invoked via wsl.exe),
 * the cwd is under /mnt/c/ but the transcript lives in the Windows user's
 * ~/.claude/projects/ directory. We detect this and check both locations.
 */
export function findClaudeProjectDir(cwd?: string): string | null {
  const dir = cwd ?? process.cwd();
  const candidates: string[] = [];

  // Candidate 1: Standard WSL encoding (e.g. /mnt/c/Users/mivid → -mnt-c-Users-mivid)
  const encoded = dir.replace(/^\//, "").replaceAll(sep === "\\" ? /[\\/]/g : /\//g, "-");
  const projectDir = join(homedir(), ".claude", "projects", `-${encoded}`);
  if (existsSync(projectDir)) candidates.push(projectDir);

  // Candidate 2: Windows-side .claude directory (when hooks run via wsl.exe from Windows Claude)
  // Windows Claude encodes paths by replacing : and \ with -, no leading dash prefix.
  // e.g. C:\Users\mivid → C--Users-mivid
  const wslMatch = dir.match(/^\/mnt\/([a-z])(\/.*)/);
  if (wslMatch) {
    const [, drive, rest] = wslMatch;
    const restEncoded = rest.replaceAll("/", "-");
    for (const d of [drive.toUpperCase(), drive.toLowerCase()]) {
      const winEncoded = `${d}-${restEncoded}`;
      const winUsersMatch = dir.match(/^\/mnt\/[a-z]\/Users\/([^/]+)/);
      const winHome = winUsersMatch
        ? `/mnt/${drive}/Users/${winUsersMatch[1]}`
        : `/mnt/${drive}/Users/Default`;
      const winProjectDir = join(winHome, ".claude", "projects", winEncoded);
      if (existsSync(winProjectDir)) candidates.push(winProjectDir);
    }
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Multiple candidates: return the one with the most recently modified .jsonl file
  let best: { dir: string; mtime: number } | null = null;
  for (const candidateDir of candidates) {
    try {
      for (const file of readdirSync(candidateDir)) {
        if (!file.endsWith(".jsonl")) continue;
        const st = statSync(join(candidateDir, file));
        if (!best || st.mtimeMs > best.mtime) {
          best = { dir: candidateDir, mtime: st.mtimeMs };
        }
      }
    } catch {
      // skip unreadable
    }
  }
  return best?.dir ?? candidates[0];
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

export interface ToolUseAction {
  tool: string;
  input: Record<string, unknown>;
}

/**
 * Read tool_use actions from a JSONL transcript file starting at a byte offset.
 * Extracts tool_use blocks from assistant messages.
 */
export function readToolUseActions(
  filePath: string,
  byteOffset: number
): { actions: ToolUseAction[]; newOffset: number } {
  const actions: ToolUseAction[] = [];

  let buf: Buffer;
  let fileSize: number;
  try {
    const fd = openSync(filePath, "r");
    try {
      fileSize = fstatSync(fd).size;
      if (byteOffset >= fileSize) {
        return { actions, newOffset: fileSize };
      }
      const readLength = Math.min(fileSize - byteOffset, MAX_TRANSCRIPT_BYTES);
      buf = Buffer.alloc(readLength);
      readSync(fd, buf, 0, readLength, byteOffset);
    } finally {
      closeSync(fd);
    }
  } catch {
    return { actions, newOffset: byteOffset };
  }

  const chunk = buf.toString("utf-8");
  const newOffset = Math.min(byteOffset + buf.length, fileSize);
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

    if (parsed.type !== "assistant") continue;

    const message = parsed.message as Record<string, unknown> | undefined;
    if (!message) continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (typeof block === "object" && block !== null) {
        const b = block as Record<string, unknown>;
        if (b.type === "tool_use" && typeof b.name === "string") {
          actions.push({
            tool: b.name,
            input: (b.input as Record<string, unknown>) ?? {},
          });
        }
      }
    }
  }

  return { actions, newOffset };
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
  let fileSize: number;
  try {
    const fd = openSync(filePath, "r");
    try {
      fileSize = fstatSync(fd).size;
      if (byteOffset >= fileSize) {
        return { messages, newOffset: fileSize };
      }
      const readLength = Math.min(fileSize - byteOffset, MAX_TRANSCRIPT_BYTES);
      buf = Buffer.alloc(readLength);
      readSync(fd, buf, 0, readLength, byteOffset);
    } finally {
      closeSync(fd);
    }
  } catch {
    return { messages, newOffset: byteOffset };
  }

  const chunk = buf.toString("utf-8");
  const newOffset = Math.min(byteOffset + buf.length, fileSize);
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

  return { messages, newOffset };
}
