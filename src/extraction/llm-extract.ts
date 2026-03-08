/**
 * LLM-based fact extraction module.
 * Calls Claude Haiku to synthesize structured project facts from session snippets.
 * Uses native fetch (Node 22) — no SDK dependencies.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtractionSnippet } from "./structural.js";
import type { TranscriptMessage } from "../storage/transcript.js";

export interface ExtractedFact {
  category: "schema" | "credentials" | "route" | "config" | "architecture" | "behavior";
  project: string;
  content: string;
}

const VALID_CATEGORIES = new Set([
  "schema",
  "credentials",
  "route",
  "config",
  "architecture",
  "behavior",
]);

const SYSTEM_PROMPT = `You extract project-specific facts from development session transcripts.
Given tool outputs and conversation snippets, identify concrete, reusable facts worth remembering across sessions.
Return a JSON array. Each item: {"category": "schema|credentials|route|config|architecture|behavior", "project": "project-name", "content": "concise fact"}

Categories:
- schema: Database tables, model fields, column types, what fields do/don't exist
- credentials: Login credentials, seed data, test accounts, API keys
- route: URL routes, middleware, authentication requirements, protected paths
- config: Environment variables, docker commands, build commands, deployment details
- architecture: How components connect, what frameworks/libraries are used
- behavior: How features actually work vs expected

Rules:
- Only extract CONCRETE facts, not opinions or plans
- Be concise — each fact should be 1-3 sentences
- Include negative facts ("X does NOT have field Y")
- If nothing worth extracting, return []
- Never include raw data dumps — summarize into reusable knowledge`;

const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1024;
const TIMEOUT_MS = 8000;

const MAX_SNIPPETS = 10;
const MAX_SNIPPET_RAW_CHARS = 300;
const MAX_MESSAGES = 5;
const MAX_MESSAGE_CHARS = 400;
const MAX_PROMPT_CHARS = 4000;

/**
 * Retrieve API token from environment or Claude's credential file.
 * Returns null if neither source is available.
 */
function getApiToken(): string | null {
  // 1. Check environment variable
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey && envKey.trim().length > 0) {
    return envKey.trim();
  }

  // 2. Read from Claude's credential file
  try {
    const credPath = join(homedir(), ".claude", ".credentials.json");
    const raw = readFileSync(credPath, "utf-8");
    const creds = JSON.parse(raw) as Record<string, unknown>;
    const oauth = creds.claudeAiOauth as Record<string, unknown> | undefined;
    if (oauth && typeof oauth.accessToken === "string" && oauth.accessToken.length > 0) {
      return oauth.accessToken;
    }
  } catch {
    // Credential file missing or unreadable
  }

  return null;
}

/**
 * Build the user prompt from snippets and messages.
 * Caps total output at MAX_PROMPT_CHARS.
 */
function buildPrompt(
  snippets: ExtractionSnippet[],
  messages: TranscriptMessage[],
  projectName: string | null
): string {
  const parts: string[] = [];

  if (projectName) {
    parts.push(`Project: ${projectName}\n`);
  }

  // Add tool output snippets (max 10, each raw capped at 300 chars)
  const selectedSnippets = snippets.slice(0, MAX_SNIPPETS);
  if (selectedSnippets.length > 0) {
    parts.push("## Tool Output Snippets\n");
    for (const s of selectedSnippets) {
      const raw =
        s.raw.length > MAX_SNIPPET_RAW_CHARS
          ? s.raw.slice(0, MAX_SNIPPET_RAW_CHARS) + "..."
          : s.raw;
      parts.push(`[${s.pattern}] ${s.summary}\nRaw: ${raw}\n`);
    }
  }

  // Add recent assistant messages for context (last 5, each capped at 400 chars)
  const recentMessages = messages.slice(-MAX_MESSAGES);
  if (recentMessages.length > 0) {
    parts.push("## Recent Conversation Context\n");
    for (const m of recentMessages) {
      const text =
        m.text.length > MAX_MESSAGE_CHARS
          ? m.text.slice(0, MAX_MESSAGE_CHARS) + "..."
          : m.text;
      parts.push(`[${m.role}]: ${text}\n`);
    }
  }

  let prompt = parts.join("\n");

  // Cap total at MAX_PROMPT_CHARS
  if (prompt.length > MAX_PROMPT_CHARS) {
    prompt = prompt.slice(0, MAX_PROMPT_CHARS) + "\n...(truncated)";
  }

  return prompt;
}

/**
 * Parse the LLM response text into ExtractedFact[].
 * Handles markdown code blocks (```json ... ```) and plain JSON arrays.
 */
function parseResponse(responseText: string): ExtractedFact[] {
  let jsonStr = responseText.trim();

  // Strip markdown code block wrapper if present
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  const parsed: unknown = JSON.parse(jsonStr);
  if (!Array.isArray(parsed)) {
    return [];
  }

  const facts: ExtractedFact[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;

    // Validate category
    if (typeof obj.category !== "string" || !VALID_CATEGORIES.has(obj.category)) continue;

    // Validate content (string, 10-2000 chars)
    if (typeof obj.content !== "string") continue;
    if (obj.content.length < 10 || obj.content.length > 2000) continue;

    // Project is a string (default to empty)
    const project = typeof obj.project === "string" ? obj.project : "";

    facts.push({
      category: obj.category as ExtractedFact["category"],
      project,
      content: obj.content,
    });
  }

  return facts;
}

/**
 * Extract project facts using Claude Haiku.
 * Returns [] on any error (timeout, API error, parse failure).
 */
export async function extractWithLLM(
  snippets: ExtractionSnippet[],
  messages: TranscriptMessage[],
  projectName: string | null
): Promise<ExtractedFact[]> {
  // Nothing to extract from
  if (snippets.length === 0 && messages.length === 0) {
    return [];
  }

  const apiToken = getApiToken();
  if (!apiToken) {
    process.stderr.write("llm-extract: no API token available, skipping extraction\n");
    return [];
  }

  const userPrompt = buildPrompt(snippets, messages, projectName);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(API_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "x-api-key": apiToken,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      process.stderr.write(
        `llm-extract: API returned ${response.status}: ${errorBody.slice(0, 200)}\n`
      );
      return [];
    }

    const body = (await response.json()) as Record<string, unknown>;
    const content = body.content;
    if (!Array.isArray(content) || content.length === 0) {
      process.stderr.write("llm-extract: unexpected API response shape\n");
      return [];
    }

    // Extract text from the first text block
    const firstBlock = content[0] as Record<string, unknown>;
    if (firstBlock.type !== "text" || typeof firstBlock.text !== "string") {
      process.stderr.write("llm-extract: no text block in API response\n");
      return [];
    }

    return parseResponse(firstBlock.text);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("abort")) {
      process.stderr.write("llm-extract: request timed out after 8s\n");
    } else {
      process.stderr.write(`llm-extract: ${message}\n`);
    }
    return [];
  }
}
