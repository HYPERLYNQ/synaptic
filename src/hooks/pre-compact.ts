/**
 * PreCompact hook: Runs transcript scan before context compaction.
 *
 * This is the safety net — if Claude failed to save corrections/insights
 * in real-time, this catches them before compaction wipes the transcript
 * from Claude's context window.
 *
 * Receives JSON on stdin: { trigger: "manual"|"auto", custom_instructions?: string }
 */

import { appendEntry } from "../storage/markdown.js";
import { ContextIndex } from "../storage/sqlite.js";
import { Embedder } from "../storage/embedder.js";
import { ensureDirs } from "../storage/paths.js";
import { detectProject } from "../storage/project.js";
import { getSessionId } from "../storage/session.js";
import {
  findCurrentTranscript,
  readCursor,
  writeCursor,
  readNewMessages,
} from "../storage/transcript.js";
import { scoreSignals } from "../storage/signals.js";

interface PreCompactInput {
  trigger: string;
  custom_instructions?: string;
}

async function scanTranscript(
  index: ContextIndex,
  embedder: Embedder,
  enrichInsert: (entry: import("../storage/markdown.js").ContextEntry) => number
): Promise<void> {
  const transcriptFile = findCurrentTranscript();
  if (!transcriptFile) return;

  const cursor = readCursor();
  const offset = (cursor && cursor.file === transcriptFile) ? cursor.offset : 0;

  const { messages, newOffset } = readNewMessages(transcriptFile, offset);
  if (messages.length === 0) {
    writeCursor({ file: transcriptFile, offset: newOffset });
    return;
  }

  await embedder.getAnchorTemplates();

  // Primary capture loop (same as stop hook)
  for (const msg of messages) {
    if (msg.text.length < 20) continue;

    const msgEmb = await embedder.embed(msg.text);
    const similar = index.searchVec(msgEmb, 1);
    if (similar.length > 0 && similar[0].distance < 0.55) continue;

    const signals = scoreSignals(msg.text);
    const match = await embedder.classifyWithAnchors(msg.text, signals.total);
    if (!match) continue;

    let tier: "ephemeral" | "working" = "ephemeral";
    if (match.confidence >= 0.50) tier = "working";

    const tags = [
      "transcript-scan",
      "pre-compact",
      `source:${msg.role}`,
      `anchor:${match.category}`,
      ...(signals.total > 0 ? [`signal:${signals.dominant}`] : []),
    ];
    const entry = appendEntry(msg.text, "insight", tags);
    entry.tier = tier;
    const rowid = enrichInsert(entry);
    index.insertVec(rowid, msgEmb);
  }

  // Real-time directive detection for user messages
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    if (msg.text.length < 20) continue;

    const signals = scoreSignals(msg.text);
    const match = await embedder.classifyWithAnchors(msg.text, signals.total);

    if (!match || match.confidence < 0.50) continue;
    if (!["rule", "standard", "correction"].includes(match.category)) continue;

    const directiveStrength = (signals.signals.directive ?? 0) +
                              (signals.signals.temporal ?? 0) +
                              (signals.signals.consistency ?? 0);
    if (directiveStrength < 0.5) continue;

    const msgEmb = await embedder.embed(msg.text);
    const existingRules = index.listRules();
    const pendingRules = index.list({ days: 7 }).filter(e => e.tags.includes("pending_rule"));
    let isDuplicate = false;

    for (const rule of [...existingRules, ...pendingRules.map(r => ({ label: "", content: r.content }))]) {
      const ruleEmb = await embedder.embed(rule.content);
      let dot = 0;
      for (let i = 0; i < msgEmb.length; i++) dot += msgEmb[i] * ruleEmb[i];
      if (dot >= 0.75) { isDuplicate = true; break; }
    }
    if (isDuplicate) continue;

    const label = msg.text.slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
    const pendingEntry = appendEntry(msg.text, "insight", [
      "pending_rule",
      "pre-compact",
      `proposed-label:${label}`,
      `anchor:${match.category}`,
    ]);
    pendingEntry.tier = "working";
    const rowid = enrichInsert(pendingEntry);
    index.insertVec(rowid, msgEmb);
  }

  // Error-resolution pattern capture
  const errorPatterns = /\b(error|failed|doesn't work|can't|couldn't|not working|undefined|ENOENT|EACCES|EPERM|exit code [1-9]|command not found|TypeError|ReferenceError|SyntaxError)\b/i;
  const resolutionPatterns = /\b(fix was|solution is|worked because|the issue was|root cause|that fixed|now works|resolved by|the problem was)\b/i;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    if (!resolutionPatterns.test(msg.text)) continue;

    const errorContext: string[] = [];
    for (let j = Math.max(0, i - 8); j < i; j++) {
      const prev = messages[j];
      if (errorPatterns.test(prev.text)) {
        const summary = prev.text.length > 200 ? prev.text.slice(0, 200) + "..." : prev.text;
        errorContext.push(`[${prev.role}] ${summary}`);
      }
    }

    if (errorContext.length === 0) continue;

    const resolution = msg.text.length > 300 ? msg.text.slice(0, 300) + "..." : msg.text;
    const debugContent = `Debugging pattern (${errorContext.length} errors before resolution):\n\nFailed attempts:\n${errorContext.map(e => `- ${e}`).join("\n")}\n\nResolution:\n${resolution}`;

    const debugEmb = await embedder.embed(debugContent);
    const debugSimilar = index.searchVec(debugEmb, 1);
    if (debugSimilar.length > 0 && debugSimilar[0].distance < 0.55) continue;

    const entry = appendEntry(debugContent, "insight", [
      "debugging-pattern",
      "transcript-scan",
      "pre-compact",
      "auto-captured",
    ]);
    entry.tier = "longterm";
    const rowid = enrichInsert(entry);
    index.insertVec(rowid, debugEmb);
  }

  writeCursor({ file: transcriptFile, offset: newOffset });
}

async function main(): Promise<void> {
  ensureDirs();

  let input: PreCompactInput = { trigger: "auto" };
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString("utf-8").trim();
    if (raw) {
      input = JSON.parse(raw);
    }
  } catch {
    // Use defaults
  }

  const index = new ContextIndex();
  const embedder = new Embedder();

  const enrichInsert = (entry: import("../storage/markdown.js").ContextEntry): number => {
    return index.insert({
      ...entry,
      project: detectProject() ?? undefined,
      sessionId: getSessionId(),
      agentId: "system",
    });
  };

  try {
    // Run transcript scan FIRST — this is the critical safety net
    try {
      await scanTranscript(index, embedder, enrichInsert);
    } catch {
      // Don't fail the hook if transcript scanning errors
    }

    // Then save the compaction snapshot
    const content = [
      `Context compaction triggered (${input.trigger}).`,
    ];

    if (input.custom_instructions) {
      content.push(`User instructions: ${input.custom_instructions}`);
    }

    const recent = index.list({ days: 1 });
    if (recent.length > 0) {
      content.push(`Active session had ${recent.length} entries today.`);
      const types = new Map<string, number>();
      for (const entry of recent) {
        types.set(entry.type, (types.get(entry.type) ?? 0) + 1);
      }
      const typeSummary = Array.from(types.entries())
        .map(([t, c]) => `${t}:${c}`)
        .join(", ");
      content.push(`Entry types: ${typeSummary}`);
    }

    const entry = appendEntry(content.join("\n"), "progress", ["compaction-snapshot"]);
    entry.tier = ContextIndex.assignTier(entry.type);
    const rowid = index.insert(entry);
    const embedding = await embedder.embed(entry.content);
    index.insertVec(rowid, embedding);
  } finally {
    index.close();
  }
}

main().catch((err) => {
  process.stderr.write(`pre-compact hook error: ${err}\n`);
  process.exit(0);
});
