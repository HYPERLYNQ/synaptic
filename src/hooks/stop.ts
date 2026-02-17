/**
 * Stop hook: Scans transcripts and saves debounced handoff notes.
 *
 * Flow: stdin → stop_hook_active? → create index/embedder → TRANSCRIPT SCAN → debounce? → handoff
 *
 * Transcript scanning runs on every response (no debounce).
 * Handoff generation is debounced to 5-minute intervals.
 *
 * Receives JSON on stdin: { stop_hook_active: boolean, ... }
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEntry } from "../storage/markdown.js";
import { ContextIndex } from "../storage/sqlite.js";
import { Embedder } from "../storage/embedder.js";
import { ensureDirs, DB_DIR } from "../storage/paths.js";
import { detectProject } from "../storage/project.js";
import { getSessionId } from "../storage/session.js";
import {
  findCurrentTranscript,
  readCursor,
  writeCursor,
  readNewMessages,
  readToolUseActions,
} from "../storage/transcript.js";
import { extractCheckPatterns, checkMessageAgainstPatterns } from "../cli/rule-patterns.js";

const DEBOUNCE_FILE = join(DB_DIR, ".last-handoff");
const DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes

interface StopInput {
  stop_hook_active?: boolean;
}

function shouldDebounce(): boolean {
  try {
    const last = parseInt(readFileSync(DEBOUNCE_FILE, "utf-8").trim(), 10);
    return !isNaN(last) && Date.now() - last < DEBOUNCE_MS;
  } catch {
    return false;
  }
}

function updateDebounceTimestamp(): void {
  writeFileSync(DEBOUNCE_FILE, Date.now().toString(), "utf-8");
}

async function scanTranscript(
  index: ContextIndex,
  embedder: Embedder,
  enrichInsert: (entry: import("../storage/markdown.js").ContextEntry) => number
): Promise<void> {
  // 1. Find current transcript file
  const transcriptFile = findCurrentTranscript();
  if (!transcriptFile) return;

  // 2. Read cursor, compute offset (reset to 0 if file changed)
  const cursor = readCursor();
  const offset = (cursor && cursor.file === transcriptFile) ? cursor.offset : 0;

  // 3. Read new messages (cap at 10 per scan)
  const { messages, newOffset } = readNewMessages(transcriptFile, offset);
  const capped = messages.slice(0, 10);

  if (capped.length === 0) {
    // Still update cursor to track position even if no qualifying messages
    writeCursor({ file: transcriptFile, offset: newOffset });
    return;
  }

  // Pre-load templates
  const intentTemplates = await embedder.getIntentTemplates();
  const categoryTemplates = await embedder.getCategoryTemplates();

  for (const msg of capped) {
    let matchResult: { category: string; similarity: number } | null = null;

    if (msg.role === "user") {
      // 4. Classify user messages with intent templates (threshold 0.3)
      matchResult = await embedder.classifySentence(msg.text, intentTemplates, 0.3);
    } else {
      // 5. Classify assistant text with category templates (threshold 0.7)
      matchResult = await embedder.classifySentence(msg.text, categoryTemplates, 0.7);
    }

    if (!matchResult) continue;

    // 6. Deduplicate via searchVec — skip if L2 distance < 0.55 (≈ cosine 0.85)
    const msgEmb = await embedder.embed(msg.text);
    const similar = index.searchVec(msgEmb, 1);
    if (similar.length > 0 && similar[0].distance < 0.55) {
      continue; // too similar to existing entry
    }

    // 7. Save as insight with transcript-scan tags
    const tags = [
      "transcript-scan",
      `source:${msg.role}`,
      `intent:${matchResult.category}`,
    ];
    const entry = appendEntry(msg.text, "insight", tags);
    entry.tier = "working";
    const rowid = enrichInsert(entry);
    index.insertVec(rowid, msgEmb);
  }

  // 8. Update cursor
  writeCursor({ file: transcriptFile, offset: newOffset });
}

/**
 * Check recent transcript for git commit tool calls that violate rules.
 * Saves violations as pinned issue entries for session-start surfacing.
 */
function checkRuleViolations(
  index: ContextIndex,
  enrichInsert: (entry: import("../storage/markdown.js").ContextEntry) => number
): void {
  const rules = index.listRules();
  if (rules.length === 0) return;

  const transcriptFile = findCurrentTranscript();
  if (!transcriptFile) return;

  const cursor = readCursor();
  // Read from start of file to catch everything (violations are rare, cost is low)
  const { actions } = readToolUseActions(transcriptFile, 0);

  for (const action of actions) {
    // Look for Bash tool calls containing git commit
    if (action.tool !== "Bash") continue;
    const command = (action.input.command as string) ?? "";
    if (!command.includes("git commit")) continue;

    // Extract the -m message
    // Guard against catastrophic backtracking on very long commands
    const cmdSlice = command.slice(0, 2000);
    const msgMatch = cmdSlice.match(/git\s+commit\s[^"']*-m\s+(?:"([^"]*)"|'([^']*)'|(\S+))/);
    if (!msgMatch) continue;
    const commitMsg = msgMatch[1] ?? msgMatch[2] ?? msgMatch[3] ?? "";

    // Also handle heredoc-style messages: -m "$(cat <<'EOF'\n...\nEOF\n)"
    const heredocMatch = cmdSlice.match(/cat\s+<<['"]?EOF['"]?\n([\s\S]*?)\nEOF/);
    const fullMsg = heredocMatch ? heredocMatch[1] : commitMsg;

    if (!fullMsg) continue;

    for (const rule of rules) {
      const patterns = extractCheckPatterns(rule.content);
      const violation = checkMessageAgainstPatterns(fullMsg, patterns);
      if (violation) {
        // Check if we already logged this violation recently (dedup)
        const recent = index.list({ days: 1 })
          .filter(e => e.tags.includes("rule-violation") && e.tags.includes(`rule:${rule.label}`));
        if (recent.length > 0) continue;

        const entry = appendEntry(
          `Rule "${rule.label}" violated: commit message contained "${violation}". Rule: ${rule.content}`,
          "issue",
          ["rule-violation", `rule:${rule.label}`]
        );
        entry.tier = "working";
        entry.pinned = true;
        enrichInsert(entry);
      }
    }
  }
}

async function main(): Promise<void> {
  ensureDirs();

  let input: StopInput = {};
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

  // Prevent infinite loops
  if (input.stop_hook_active) {
    return;
  }

  // Create index/embedder BEFORE debounce — transcript scan needs them
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
    // Transcript scan runs on EVERY response (no debounce)
    try {
      await scanTranscript(index, embedder, enrichInsert);
    } catch {
      // Don't fail the hook if transcript scanning errors
    }

    // Rule violation detection (soft enforcement)
    try {
      checkRuleViolations(index, enrichInsert);
    } catch {
      // Don't fail the hook if violation checking errors
    }

    // Debounce: skip handoff if one was saved recently
    if (shouldDebounce()) {
      return;
    }

    // Check if there's been meaningful activity today
    const todayEntries = index.list({ days: 1 });
    if (todayEntries.length === 0) {
      return; // No activity to create a handoff for
    }

    // Create a handoff summary from today's entries
    const types = new Map<string, number>();
    const tags = new Set<string>();
    for (const entry of todayEntries) {
      types.set(entry.type, (types.get(entry.type) ?? 0) + 1);
      entry.tags.forEach((t) => tags.add(t));
    }

    const tagList = Array.from(tags);

    // Collect real-time insight saves from today (the primary distillation source)
    const todayInsights = todayEntries
      .filter(e => e.type === "insight")
      .slice(0, 5);

    const contentParts: string[] = [];

    // Activity line
    const projects = new Set(todayEntries.map(e => e.project).filter(Boolean));
    const projectStr = projects.size > 0 ? ` across ${Array.from(projects).join(", ")}` : "";
    contentParts.push(`Activity: ${todayEntries.length} entries${projectStr}.`);

    // Learnings section (from real-time insight saves)
    if (todayInsights.length > 0) {
      contentParts.push("Learnings:");
      for (const insight of todayInsights) {
        const summary = insight.content.length > 150
          ? insight.content.slice(0, 150) + "..."
          : insight.content;
        contentParts.push(`- ${summary}`);
      }
    }

    // Pre-filter non-insight entries for use by safety net + intent classification
    const nonInsightEntries = todayEntries
      .filter(e => e.type !== "insight" && e.type !== "handoff" && e.type !== "git_commit" && e.type !== "rule");

    // Layer 2: Embedder safety net — classify remaining entries for missed learnings
    try {
      if (nonInsightEntries.length > 0 && todayInsights.length < 5) {
        const categoryTemplates = await embedder.getCategoryTemplates();
        const remaining = 5 - todayInsights.length;
        const candidates: Array<{ content: string; category: string; similarity: number }> = [];

        for (const entry of nonInsightEntries.slice(0, 20)) {
          const match = await embedder.classifySentence(entry.content, categoryTemplates, 0.7);
          if (match) {
            candidates.push({ content: entry.content, ...match });
          }
        }

        // Sort by similarity, take top N
        candidates.sort((a, b) => b.similarity - a.similarity);
        const extras = candidates.slice(0, remaining);
        if (extras.length > 0 && todayInsights.length === 0) {
          contentParts.push("Learnings:");
        }
        for (const extra of extras) {
          const summary = extra.content.length > 150 ? extra.content.slice(0, 150) + "..." : extra.content;
          contentParts.push(`- ${summary}`);
        }
      }

      // Correction detection — scan for directive patterns, save as pending rules
      const directiveTemplates = await embedder.getDirectiveTemplates();
      const corrections: Array<{ content: string; category: string }> = [];

      for (const entry of todayEntries.filter(e => e.tags.includes("correction"))) {
        corrections.push({ content: entry.content, category: "explicit" });
      }

      // Also check non-tagged entries for directive language
      for (const entry of nonInsightEntries.slice(0, 15)) {
        const match = await embedder.classifySentence(entry.content, directiveTemplates, 0.75);
        if (match && !corrections.some(c => c.content === entry.content)) {
          corrections.push({ content: entry.content, category: match.category });
        }
      }

      // Check for conflicts with existing rules
      const existingRules = index.listRules();
      if (existingRules.length > 0 && corrections.length > 0) {
        for (const corr of corrections) {
          const corrEmb = await embedder.embed(corr.content);
          for (const rule of existingRules) {
            const ruleEmb = await embedder.embed(rule.content);
            // Cosine similarity (both L2-normalized)
            let dot = 0;
            for (let i = 0; i < corrEmb.length; i++) {
              dot += corrEmb[i] * ruleEmb[i];
            }
            if (dot >= 0.7) {
              // Conflict detected — save as conflict entry
              const conflictEntry = appendEntry(
                `Conflict: new correction "${corr.content.slice(0, 80)}" may contradict rule "${rule.label}": "${rule.content.slice(0, 80)}"`,
                "insight",
                ["rule_conflict", `conflicts-with:${rule.label}`]
              );
              conflictEntry.tier = "working";
              const conflictRowid = enrichInsert(conflictEntry);
              const conflictEmb = await embedder.embed(conflictEntry.content);
              index.insertVec(conflictRowid, conflictEmb);
            }
          }
        }
      }

      // Save corrections as pending rule proposals
      if (corrections.length > 0) {
        for (const corr of corrections.slice(0, 3)) {
          const label = corr.content.slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
          const pendingEntry = appendEntry(
            corr.content,
            "insight",
            ["pending_rule", `proposed-label:${label}`]
          );
          pendingEntry.tier = "working";
          const corrRowid = enrichInsert(pendingEntry);
          const emb = await embedder.embed(corr.content);
          index.insertVec(corrRowid, emb);
        }
        contentParts.push(`Corrections detected: ${corrections.length} pending rule proposal(s) saved.`);
      }
    } catch {
      // Don't fail the handoff if classification errors
    }

    // Intent classification — autonomous capture of declarations, preferences, etc.
    try {
      const intentTemplates = await embedder.getIntentTemplates();
      const autoCaptures: Array<{ content: string; category: string; similarity: number }> = [];

      for (const entry of nonInsightEntries.slice(0, 20)) {
        const match = await embedder.classifySentence(entry.content, intentTemplates, 0.3);
        if (match) {
          // Deduplicate: check if similar entry already exists as reference or rule
          const existingRefs = index.list({ days: 30 })
            .filter(e => e.type === "reference" || e.type === "rule");

          let isDuplicate = false;
          const entryEmb = await embedder.embed(entry.content);
          for (const ref of existingRefs.slice(0, 30)) {
            const refEmb = await embedder.embed(ref.content);
            let dot = 0;
            for (let i = 0; i < entryEmb.length; i++) {
              dot += entryEmb[i] * refEmb[i];
            }
            if (dot >= 0.8) {
              isDuplicate = true;
              break;
            }
          }

          if (!isDuplicate) {
            autoCaptures.push({ content: entry.content, ...match });
          }
        }
      }

      // Save auto-captured intents
      const capturedCounts = new Map<string, number>();
      for (const capture of autoCaptures.slice(0, 5)) {
        const type = (capture.category === "frustration") ? "issue" : "reference";
        const tier = (capture.category === "frustration") ? "working" : "longterm";

        const captureEntry = appendEntry(
          capture.content,
          type,
          ["auto-captured", `intent:${capture.category}`]
        );
        captureEntry.tier = tier;
        const captureRowid = enrichInsert(captureEntry);
        const captureEmb = await embedder.embed(capture.content);
        index.insertVec(captureRowid, captureEmb);

        capturedCounts.set(capture.category, (capturedCounts.get(capture.category) ?? 0) + 1);
      }

      if (capturedCounts.size > 0) {
        const parts = Array.from(capturedCounts.entries()).map(([cat, count]) => `${count} ${cat}(s)`);
        contentParts.push(`Auto-captured: ${parts.join(", ")}`);
      }
    } catch {
      // Don't fail the handoff if intent classification errors
    }

    const content = contentParts.join("\n");

    const entry = appendEntry(content, "handoff", tagList);
    entry.tier = ContextIndex.assignTier(entry.type);
    const rowid = enrichInsert(entry);
    const embedding = await embedder.embed(entry.content);
    index.insertVec(rowid, embedding);

    // Bump access for entries that contributed to handoff learnings
    for (const insight of todayInsights) {
      index.touchEntry(insight.id);
    }

    // Also bump corrections that fed into pending rules
    for (const entry of todayEntries.filter(e => e.tags.includes("correction"))) {
      index.touchEntry(entry.id);
    }

    updateDebounceTimestamp();
  } finally {
    index.close();
  }
}

main().catch((err) => {
  process.stderr.write(`stop hook error: ${err}\n`);
  process.exit(0);
});
