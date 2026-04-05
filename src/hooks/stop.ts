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
  readToolResults,
} from "../storage/transcript.js";
import { extractStructuredSnippets } from "../extraction/structural.js";
import { extractWithLLM } from "../extraction/llm-extract.js";
import { extractCheckPatterns, checkMessageAgainstPatterns } from "../cli/rule-patterns.js";
import { isSyncEnabled, readSyncState, pushEntries } from "../storage/sync.js";
import { scoreSignals } from "../storage/signals.js";
import { contentHash } from "../storage/search-utils.js";

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

  // 3. Read new messages (no cap — readNewMessages already caps at 10MB)
  const { messages, newOffset } = readNewMessages(transcriptFile, offset);

  if (messages.length === 0) {
    writeCursor({ file: transcriptFile, offset: newOffset });
    return;
  }

  // Pre-load anchor templates once
  await embedder.getAnchorTemplates();

  // === Primary capture loop: semantics-first with signal boost ===
  for (const msg of messages) {
    // Skip very short messages (no semantic value)
    if (msg.text.length < 20) continue;

    // 1. Embed the message (cached)
    const msgEmb = await embedder.embed(msg.text);

    // 2. Deduplicate via vector similarity
    const similar = index.searchVec(msgEmb, 1);
    if (similar.length > 0 && similar[0].distance < 0.55) continue;

    // 3. Score regex signals (fast boost layer)
    const signals = scoreSignals(msg.text);

    // 4. Classify against semantic anchors with signal boost
    const match = await embedder.classifyWithAnchors(msg.text, signals.total);

    // 5. Skip if no anchor matches even with boost
    if (!match) continue;

    // 6. Determine tier based on confidence
    let tier: "ephemeral" | "working" = "ephemeral";
    if (match.confidence >= 0.50) tier = "working";

    // 7. Save with semantic category + signal info
    const tags = [
      "transcript-scan",
      `source:${msg.role}`,
      `anchor:${match.category}`,
      ...(signals.total > 0 ? [`signal:${signals.dominant}`] : []),
    ];
    const entry = appendEntry(msg.text, "insight", tags);
    entry.tier = tier;
    const rowid = enrichInsert(entry);
    index.insertVec(rowid, msgEmb);
  }

  // === Real-time directive detection for user messages ===
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    if (msg.text.length < 20) continue;

    const signals = scoreSignals(msg.text);
    const match = await embedder.classifyWithAnchors(msg.text, signals.total);

    // Only promote to pending rule if classified as rule/standard/correction with high confidence
    if (!match || match.confidence < 0.50) continue;
    if (!["rule", "standard", "correction"].includes(match.category)) continue;

    // Must also have directive/temporal/consistency signal words (semantic + signal agreement)
    const directiveStrength = (signals.signals.directive ?? 0) +
                              (signals.signals.temporal ?? 0) +
                              (signals.signals.consistency ?? 0);
    if (directiveStrength < 0.5) continue;

    // Content-hash dedup: fast check for exact/near-exact content
    const hash = contentHash(msg.text);
    const recentPending = index.list({ days: 30 }).filter(e => e.tags.includes("pending_rule"));
    const hashMatch = recentPending.find(e => contentHash(e.content) === hash);
    if (hashMatch) {
      index.updateTimestamp(hashMatch.id);
      continue;
    }

    // Vector dedup: check against existing rules + pending rules
    const msgEmb = await embedder.embed(msg.text);
    const existingRules = index.listRules();
    let isDuplicate = false;

    for (const rule of [...existingRules, ...recentPending.map(r => ({ label: "", content: r.content }))]) {
      const ruleEmb = await embedder.embed(rule.content);
      let dot = 0;
      for (let i = 0; i < msgEmb.length; i++) dot += msgEmb[i] * ruleEmb[i];
      if (dot >= 0.70) { isDuplicate = true; break; }
    }
    if (isDuplicate) continue;

    const label = msg.text.slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
    const pendingEntry = appendEntry(msg.text, "insight", [
      "pending_rule",
      `proposed-label:${label}`,
      `anchor:${match.category}`,
    ]);
    pendingEntry.tier = "working";
    const rowid = enrichInsert(pendingEntry);
    index.insertVec(rowid, msgEmb);
  }

  // === Error-resolution pattern capture ===
  const errorPatterns = /\b(error|failed|doesn't work|can't|couldn't|not working|undefined|ENOENT|EACCES|EPERM|exit code [1-9]|command not found|TypeError|ReferenceError|SyntaxError)\b/i;
  const resolutionPatterns = /\b(fix was|solution is|worked because|the issue was|root cause|that fixed|now works|resolved by|the problem was)\b/i;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    if (!resolutionPatterns.test(msg.text)) continue;

    // Found a resolution — look backwards for error context
    const errorContext: string[] = [];
    for (let j = Math.max(0, i - 8); j < i; j++) {
      const prev = messages[j];
      if (errorPatterns.test(prev.text)) {
        const summary = prev.text.length > 200 ? prev.text.slice(0, 200) + "..." : prev.text;
        errorContext.push(`[${prev.role}] ${summary}`);
      }
    }

    // Only save if there were actual errors before the resolution (trial-and-error)
    if (errorContext.length === 0) continue;

    // Compose a rich debugging insight
    const resolution = msg.text.length > 300 ? msg.text.slice(0, 300) + "..." : msg.text;
    const debugContent = `Debugging pattern (${errorContext.length} errors before resolution):\n\nFailed attempts:\n${errorContext.map(e => `- ${e}`).join("\n")}\n\nResolution:\n${resolution}`;

    // Deduplicate
    const debugEmb = await embedder.embed(debugContent);
    const debugSimilar = index.searchVec(debugEmb, 1);
    if (debugSimilar.length > 0 && debugSimilar[0].distance < 0.55) continue;

    const entry = appendEntry(debugContent, "insight", [
      "debugging-pattern",
      "transcript-scan",
      "auto-captured",
    ]);
    entry.tier = "longterm";
    const rowid = enrichInsert(entry);
    index.insertVec(rowid, debugEmb);
  }

  // Update cursor
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
    // Save pre-scan cursor offset BEFORE scanTranscript advances it.
    // Hybrid extraction needs to read the same new content that scanTranscript processes.
    const preScanTranscript = findCurrentTranscript();
    const preScanCursor = readCursor();
    const preScanOffset = (preScanCursor && preScanTranscript && preScanCursor.file === preScanTranscript)
      ? preScanCursor.offset : 0;

    // Transcript scan runs on EVERY response (no debounce)
    try {
      await scanTranscript(index, embedder, enrichInsert);
    } catch {
      // Don't fail the hook if transcript scanning errors
    }

    // === Hybrid extraction: structural parsing + LLM synthesis ===
    try {
      const transcriptFile = preScanTranscript;
      if (transcriptFile) {
        const toolOffset = preScanOffset;
        const { results: toolResults } = readToolResults(transcriptFile, toolOffset);

        if (toolResults.length > 0) {
          // Layer 1: structural pattern matching (cap input to prevent excessive processing)
          const snippets = extractStructuredSnippets(toolResults.slice(0, 50));

          if (snippets.length > 0) {
            // Layer 3: LLM synthesis (skips gracefully if no API token)
            const { messages } = readNewMessages(transcriptFile, toolOffset);
            const projectName = detectProject() ?? null;
            const facts = await extractWithLLM(snippets, messages, projectName);

            // Save extracted facts with vector dedup
            for (const fact of facts.slice(0, 5)) {
              const factContent = fact.content;
              const factEmb = await embedder.embed(factContent);

              // Dedup: skip if very similar entry already exists (L2 distance < 0.40)
              const similar = index.searchVec(factEmb, 1);
              if (similar.length > 0 && similar[0].distance < 0.40) continue;

              const entry = appendEntry(factContent, "reference", [
                "llm-extracted",
                `category:${fact.category}`,
                ...(projectName ? [projectName] : []),
              ]);
              entry.tier = "longterm";
              const rowid = enrichInsert(entry);
              index.insertVec(rowid, factEmb);
            }
          }
        }
      }
    } catch (err) {
      process.stderr.write(`hybrid-extraction error: ${err}\n`);
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
    // IMPORTANT: Exclude handoffs and their derivatives to prevent recursive nesting.
    // Previous handoffs contain "Activity: N entries..." which, if included, get
    // summarized into the next handoff, creating infinite recursion.
    const todayEntriesRaw = index.list({ days: 1 });
    const todayEntries = todayEntriesRaw.filter(e =>
      e.type !== "handoff" &&
      !e.content.startsWith("Activity:") &&
      !e.content.startsWith("Context compaction triggered")
    );
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

    // Filter out meta-tags from handoff system
    const filteredTags = Array.from(tags).filter(t =>
      !t.startsWith("proposed-label:") &&
      !t.startsWith("compaction-snapshot") &&
      t !== "transcript-scan" &&
      t !== "pending_rule"
    );
    const tagList = filteredTags;

    const contentParts: string[] = [];

    // Group entries by project for structured handoff
    const byProject = new Map<string, typeof todayEntries>();
    for (const entry of todayEntries) {
      const proj = entry.project || "general";
      if (!byProject.has(proj)) byProject.set(proj, []);
      byProject.get(proj)!.push(entry);
    }

    for (const [project, entries] of byProject) {
      const typeCounts = new Map<string, number>();
      for (const e of entries) typeCounts.set(e.type, (typeCounts.get(e.type) ?? 0) + 1);
      const typeStr = Array.from(typeCounts.entries())
        .map(([t, c]) => `${t}:${c}`)
        .join(", ");

      contentParts.push(`**${project}** (${entries.length} entries — ${typeStr}):`);

      // Get insights for this project (up to 8, 300 char limit)
      const projectInsights = entries
        .filter(e =>
          e.type === "insight" &&
          !e.tags.includes("pending_rule") &&
          !e.tags.includes("transcript-scan") &&
          !e.content.startsWith("Activity:")
        )
        .slice(0, 8);

      if (projectInsights.length > 0) {
        contentParts.push("Learnings:");
        for (const insight of projectInsights) {
          const summary = insight.content.length > 300
            ? insight.content.slice(0, 300) + "..."
            : insight.content;
          contentParts.push(`- ${summary}`);
        }
      }

      // List pending/TODO items
      const pending = entries.filter(e =>
        e.tags.some(t => ["todo", "pending", "next", "in-progress"].includes(t))
      );
      if (pending.length > 0) {
        contentParts.push("Pending:");
        for (const p of pending.slice(0, 5)) {
          contentParts.push(`- ${p.content.slice(0, 200)}`);
        }
      }
    }

    // Keep todayInsights reference for compatibility with safety net below
    const todayInsights = todayEntries
      .filter(e =>
        e.type === "insight" &&
        !e.tags.includes("pending_rule") &&
        !e.content.startsWith("Activity:")
      )
      .slice(0, 5);

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
      // Filter out auto-generated entries to prevent feedback loops
      const candidateEntries = nonInsightEntries
        .filter(e =>
          !e.tags.includes("auto-captured") &&
          !e.tags.includes("transcript-scan") &&
          !e.tags.includes("pending_rule") &&
          !e.tags.includes("rule_conflict") &&
          !e.tags.includes("debugging-pattern")
        )
        .slice(0, 15);

      // Pre-load existing pending rules for deduplication
      const existingPending = index.list({ days: 7 })
        .filter(e => e.tags.includes("pending_rule"));

      for (const entry of candidateEntries) {
        const match = await embedder.classifySentence(entry.content, directiveTemplates, 0.75);
        if (match && !corrections.some(c => c.content === entry.content)) {
          // Deduplicate against existing pending rules
          const entryEmb = await embedder.embed(entry.content);
          let isDuplicate = false;
          for (const pending of existingPending) {
            const pendingEmb = await embedder.embed(pending.content);
            let dot = 0;
            for (let i = 0; i < entryEmb.length; i++) dot += entryEmb[i] * pendingEmb[i];
            if (dot >= 0.75) { isDuplicate = true; break; }
          }
          if (!isDuplicate) {
            corrections.push({ content: entry.content, category: match.category });
          }
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
        const recentPendingForCorr = index.list({ days: 30 }).filter(e => e.tags.includes("pending_rule"));
        for (const corr of corrections.slice(0, 3)) {
          // Content-hash dedup
          const corrHash = contentHash(corr.content);
          const existingMatch = recentPendingForCorr.find(e => contentHash(e.content) === corrHash);
          if (existingMatch) {
            index.updateTimestamp(existingMatch.id);
            continue;
          }

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

    // Cap tags to prevent bloat — keep only the most relevant project/topic tags
    const cappedTags = tagList.slice(0, 15);
    const entry = appendEntry(content, "handoff", cappedTags);
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

    // Push entries to GitHub sync
    try {
      if (isSyncEnabled()) {
        const syncState = readSyncState();
        if (syncState) await pushEntries(index, syncState);
      }
    } catch {
      // Don't fail the hook
    }
  } finally {
    index.close();
  }
}

main().catch((err) => {
  process.stderr.write(`stop hook error: ${err}\n`);
  process.exit(0);
});
