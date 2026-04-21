import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
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
  project?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  name?: string;
  summary?: string;
  projectRoot?: string;
  referencedEntryIds?: string[];
}

function generateId(): string {
  return Date.now().toString(36) + randomBytes(4).toString("hex").slice(0, 6);
}

function formatTime(): string {
  const now = new Date();
  return now.toTimeString().slice(0, 5); // HH:MM in local tz
}

function formatDate(): string {
  // MUST match the timezone used by `formatTime()` — local. Previously used
  // `toISOString()` (UTC), which diverged from the local HH:MM any time an
  // entry was created across UTC midnight: the UTC date had already rolled
  // to tomorrow while local time was still today's 22:xx — producing a
  // fictional "2026-04-21 22:36" pair that parses as a future wall time.
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export interface AppendEntryMeta {
  name?: string;
  summary?: string;
  projectRoot?: string;
  referencedEntryIds?: string[];
  pinned?: boolean;
}

export function appendEntry(
  content: string,
  type: string,
  tags: string[],
  meta: AppendEntryMeta = {}
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

  const metaLines: string[] = [`<!-- id:${id} -->`];
  if (meta.name)         metaLines.push(`<!-- name:${meta.name} -->`);
  if (meta.summary)      metaLines.push(`<!-- summary:${meta.summary} -->`);
  if (meta.projectRoot)  metaLines.push(`<!-- projectRoot:${meta.projectRoot} -->`);
  if (meta.referencedEntryIds && meta.referencedEntryIds.length > 0) {
    metaLines.push(`<!-- refs:${meta.referencedEntryIds.join(",")} -->`);
  }
  if (meta.pinned)       metaLines.push(`<!-- pinned:1 -->`);

  const entryBlock = `\n## ${time} | ${type} | ${tagStr}\n${metaLines.join("\n")}\n${content}\n`;
  fileContent += entryBlock;
  writeFileSync(filePath, fileContent, "utf-8");

  return {
    id, date, time, type, tags, content, sourceFile: filePath,
    name: meta.name,
    summary: meta.summary,
    projectRoot: meta.projectRoot,
    referencedEntryIds: meta.referencedEntryIds,
    pinned: meta.pinned,
  };
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

    const parts = header.split("|").map((s) => s.trim());
    if (parts.length < 2) continue;

    const time = parts[0];
    const type = parts[1];
    const tagStr = parts.slice(2).join(", ");
    const tags = tagStr
      ? tagStr.split(",").map((t) => t.trim()).filter(Boolean)
      : [];

    const idMatch      = body.match(/<!--\s*id:(\S+?)\s*-->/);
    const nameMatch    = body.match(/<!--\s*name:(\S+?)\s*-->/);
    const summaryMatch = body.match(/<!--\s*summary:(.*?)\s*-->/);
    const rootMatch    = body.match(/<!--\s*projectRoot:(.+?)\s*-->/);
    const refsMatch    = body.match(/<!--\s*refs:(.+?)\s*-->/);
    const pinnedMatch  = body.match(/<!--\s*pinned:1\s*-->/);

    const id = idMatch?.[1] ?? generateId();
    const content = body.replace(/<!--[^>]*-->\s*/g, "").trim();

    const entry: ContextEntry = { id, date, time, type, tags, content, sourceFile };
    if (nameMatch)    entry.name = nameMatch[1];
    if (summaryMatch) entry.summary = summaryMatch[1];
    if (rootMatch)    entry.projectRoot = rootMatch[1];
    if (refsMatch)    entry.referencedEntryIds = refsMatch[1].split(",").map(s => s.trim()).filter(Boolean);
    if (pinnedMatch)  entry.pinned = true;

    entries.push(entry);
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
