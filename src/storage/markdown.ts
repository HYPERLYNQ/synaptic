import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dateToFilePath, CONTEXT_DIR } from "./paths.js";

export interface ContextEntry {
  id: string;
  date: string;
  time: string;
  type: string;
  tags: string[];
  content: string;
  sourceFile: string;
  tier?: "ephemeral" | "working" | "longterm";
  accessCount?: number;
  lastAccessed?: string | null;
  pinned?: boolean;
  archived?: boolean;
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function formatTime(): string {
  const now = new Date();
  return now.toTimeString().slice(0, 5); // HH:MM
}

function formatDate(): string {
  const now = new Date();
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

export function appendEntry(
  content: string,
  type: string,
  tags: string[]
): ContextEntry {
  const date = formatDate();
  const time = formatTime();
  const id = generateId();
  const filePath = dateToFilePath(date);
  const tagStr = tags.join(", ");

  let fileContent = "";
  if (existsSync(filePath)) {
    fileContent = readFileSync(filePath, "utf-8");
  } else {
    fileContent = `# Context Log: ${date}\n`;
  }

  const entryBlock = `\n## ${time} | ${type} | ${tagStr}\n<!-- id:${id} -->\n${content}\n`;
  fileContent += entryBlock;
  writeFileSync(filePath, fileContent, "utf-8");

  return { id, date, time, type, tags, content, sourceFile: filePath };
}

export function parseMarkdownFile(filePath: string): ContextEntry[] {
  if (!existsSync(filePath)) return [];

  const text = readFileSync(filePath, "utf-8");
  return parseMarkdownText(text, filePath);
}

export function parseMarkdownText(
  text: string,
  sourceFile: string
): ContextEntry[] {
  const entries: ContextEntry[] = [];
  // Extract date from header or filename
  const dateMatch =
    text.match(/^# Context Log: (\d{4}-\d{2}-\d{2})/m) ??
    sourceFile.match(/(\d{4}-\d{2}-\d{2})\.md$/);
  const date = dateMatch?.[1] ?? "unknown";

  // Split on ## headers
  const sections = text.split(/^## /m).slice(1);

  for (const section of sections) {
    const headerEnd = section.indexOf("\n");
    if (headerEnd === -1) continue;

    const header = section.slice(0, headerEnd).trim();
    const body = section.slice(headerEnd + 1).trim();

    // Parse header: "HH:MM | type | tags"
    const parts = header.split("|").map((s) => s.trim());
    if (parts.length < 2) continue;

    const time = parts[0];
    const type = parts[1];
    const tagStr = parts.slice(2).join(", ");
    const tags = tagStr
      ? tagStr.split(",").map((t) => t.trim()).filter(Boolean)
      : [];

    // Extract id from <!-- id:xxx --> comment
    const idMatch = body.match(/<!-- id:(\S+) -->/);
    const id = idMatch?.[1] ?? generateId();

    // Content is everything after the id comment (or all of body if no id)
    const content = body.replace(/<!-- id:\S+ -->\n?/, "").trim();

    entries.push({ id, date, time, type, tags, content, sourceFile });
  }

  return entries;
}

export function listMarkdownFiles(): string[] {
  if (!existsSync(CONTEXT_DIR)) return [];
  return readdirSync(CONTEXT_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => `${CONTEXT_DIR}/${f}`);
}
