# Synaptic Auto-Save & Checkpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Synaptic auto-save context entries when the user types intent phrases like "save progress" or invokes `/checkpoint`, and when meaningful artifacts land via tool use (git commits, plan file writes). Eliminate the gap where the assistant has to manually decide to call `context_save` mid-session.

**Architecture:** Two new lifecycle hooks + one new slash command, plus the project's first unit-test infrastructure (vitest):

1. **`UserPromptSubmit` hook** (`src/hooks/user-prompt-submit.ts`) — runs on every user turn. Cheap regex-based intent detection (no embeddings on the hot path). When it matches, calls the same internal save path used by the `context_save` MCP tool, writing a `handoff`-typed entry so it surfaces in the existing SessionStart "Recent Handoff" block.
2. **`PostToolUse` hook** (`src/hooks/post-tool-use.ts`) — runs after every tool call. A pure classifier inspects `(tool_name, tool_input, tool_response)` and decides whether the event is "significant" (e.g., `git commit`, write of a file under `docs/superpowers/plans/`). On match, saves a `handoff` entry summarizing the artifact.
3. **`/checkpoint [name]` slash command** (`commands/checkpoint.md`) — surfaces an explicit, autocompleting affordance. The command body emits "/checkpoint <args>" as a plain prompt, which the `UserPromptSubmit` hook then handles.

**Why `handoff` instead of a new `checkpoint` entry type:** the user explicitly chose "no new entry type — the latest save IS your save point." `handoff` already auto-surfaces in `src/hooks/session-start.ts` (the "Recent Handoff" block), so saving as `handoff` requires no SessionStart changes and inherits all existing recall affordances. Tags (`auto-save`, `trigger:user-prompt`, `trigger:tool-use`, `trigger:checkpoint-cmd`) distinguish source.

**Tech stack:** TypeScript, Node.js (existing), `vitest` (new — synaptic has no unit-test framework today; we add one as Task 1 because TDD requires it). Embedder reuse from `src/storage/embedder.ts` is deferred — v1 uses regex only on the hot path (per "moderate" aggressiveness chosen by user; embedding upgrade is a follow-up).

**Boundary — what this does NOT do:**
- No new entry `type` (uses existing `handoff`)
- No SessionStart panel changes (existing "Recent Handoff" block is enough)
- No `/load` command, no multi-checkpoint browser, no chain visualization (deferred — only build if needed)
- No embedding-based intent detection on the per-prompt hot path (regex only; embeddings stay in `Stop` and `PreCompact` hooks where latency budget allows)

**Logistics:** `/home/hyperlynq/synaptic/.mcp.json` is locked while Claude Code is running, but only git operations that rewrite that file fail. Editing `.claude-plugin/plugin.json`, `package.json`, and adding new files is fine. Run this plan in a `git worktree` to be safe — see Task 0.

---

## File Structure

```
synaptic/
├── .claude-plugin/
│   ├── plugin.json                              # MODIFY: register UserPromptSubmit + PostToolUse
│   └── hook-launcher.cjs                        # MODIFY: add to VALID_HOOKS
├── commands/                                    # NEW directory
│   └── checkpoint.md                            # NEW: /checkpoint slash command
├── package.json                                 # MODIFY: add vitest devDep + test script
├── vitest.config.ts                             # NEW: vitest config
├── src/
│   ├── cli.ts                                   # MODIFY: dispatch new hook subcommands
│   └── hooks/
│       ├── user-prompt-submit.ts                # NEW
│       ├── post-tool-use.ts                     # NEW
│       └── lib/
│           ├── triggers.ts                      # NEW: pure intent-detection function
│           ├── tool-events.ts                   # NEW: pure tool-classification function
│           └── save-handoff.ts                  # NEW: shared save helper that wraps appendEntry + ContextIndex.insert + insertVec
└── tests/                                       # NEW directory
    ├── sanity.test.ts                           # NEW: confirms vitest works
    └── hooks/
        ├── triggers.test.ts                     # NEW
        └── tool-events.test.ts                  # NEW
```

The two new hook files are intentionally thin — they parse stdin, call the pure modules in `src/hooks/lib/`, and dispatch to the shared save helper. Logic worth testing lives in `src/hooks/lib/`.

---

## Phase 0: Setup

### Task 0: Create a worktree for safe execution

**Files:** none (worktree only)

- [ ] **Step 1: Create the worktree**

Run from `/home/hyperlynq/synaptic`:

```bash
git fetch origin
git worktree add ../synaptic-auto-save -b feat/auto-save-checkpoints origin/main
```

Expected: a sibling directory `/home/hyperlynq/synaptic-auto-save/` exists, on a new branch `feat/auto-save-checkpoints`.

- [ ] **Step 2: Verify worktree state**

```bash
cd /home/hyperlynq/synaptic-auto-save
git status
git branch --show-current
```

Expected: clean working tree on `feat/auto-save-checkpoints`.

- [ ] **Step 3: All subsequent tasks run from the worktree**

For the rest of this plan, the working directory is `/home/hyperlynq/synaptic-auto-save/`. The original `/home/hyperlynq/synaptic/` is untouched.

---

## Phase 1: Test Infrastructure

### Task 1: Install vitest and add a sanity test

**Files:**
- Modify: `/home/hyperlynq/synaptic-auto-save/package.json`
- Create: `/home/hyperlynq/synaptic-auto-save/vitest.config.ts`
- Create: `/home/hyperlynq/synaptic-auto-save/tests/sanity.test.ts`

- [ ] **Step 1: Install vitest as a dev dependency**

Run from worktree root:

```bash
npm install --save-dev vitest@^2.1.0
```

Expected: `package.json` `devDependencies` now includes `"vitest": "^2.1.0"`. `package-lock.json` is updated.

- [ ] **Step 2: Add test scripts**

Edit `package.json`. Find the `"scripts"` object. Add these entries (keep existing scripts like `smoke-test`):

```json
"test": "vitest run",
"test:watch": "vitest"
```

Save. Verify:

```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf8')).scripts.test)"
```

Expected output: `vitest run`

- [ ] **Step 3: Create vitest config**

Create `vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
});
```

- [ ] **Step 4: Write a failing sanity test**

Create `tests/sanity.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

describe("vitest sanity", () => {
  it("runs and asserts basic equality", () => {
    expect(1 + 1).toBe(2);
  });

  it("can import from src", async () => {
    const mod = await import("../src/storage/embedder.js");
    expect(typeof mod).toBe("object");
  });
});
```

- [ ] **Step 5: Run the test**

```bash
npm test
```

Expected: vitest discovers `tests/sanity.test.ts`, runs 2 tests, both pass. If the second test fails because `embedder.js` is at a different path, change the import target to a known module (`../src/cli.js` or any file confirmed via `ls src/storage/`).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts tests/sanity.test.ts
git commit -m "test: add vitest unit-test infrastructure"
```

---

## Phase 2: UserPromptSubmit Hook

### Task 2: Pure trigger-detection module + tests

**Files:**
- Create: `/home/hyperlynq/synaptic-auto-save/src/hooks/lib/triggers.ts`
- Create: `/home/hyperlynq/synaptic-auto-save/tests/hooks/triggers.test.ts`

This module is pure — string in, structured intent out. No I/O, no DB, no embeddings. Easy to test exhaustively.

- [ ] **Step 1: Write the failing test**

Create `tests/hooks/triggers.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { detectSaveIntent } from "../../src/hooks/lib/triggers.js";

describe("detectSaveIntent — explicit /checkpoint command", () => {
  it("matches /checkpoint with no name", () => {
    const r = detectSaveIntent("/checkpoint");
    expect(r.matched).toBe(true);
    expect(r.kind).toBe("checkpoint-command");
    expect(r.name).toBeUndefined();
  });

  it("matches /checkpoint with a name", () => {
    const r = detectSaveIntent("/checkpoint white-hat-boundary");
    expect(r.matched).toBe(true);
    expect(r.kind).toBe("checkpoint-command");
    expect(r.name).toBe("white-hat-boundary");
  });

  it("matches /checkpoint with multi-word name", () => {
    const r = detectSaveIntent("/checkpoint stack decision tauri vs nextjs");
    expect(r.matched).toBe(true);
    expect(r.name).toBe("stack decision tauri vs nextjs");
  });
});

describe("detectSaveIntent — natural-language triggers", () => {
  it("matches 'save progress'", () => {
    const r = detectSaveIntent("save progress");
    expect(r.matched).toBe(true);
    expect(r.kind).toBe("natural-language");
  });

  it("matches 'save the progress'", () => {
    expect(detectSaveIntent("can you save the progress").matched).toBe(true);
  });

  it("matches 'checkpoint this' / 'create a checkpoint'", () => {
    expect(detectSaveIntent("checkpoint this").matched).toBe(true);
    expect(detectSaveIntent("create a checkpoint").matched).toBe(true);
  });

  it("matches 'save the game' (game-style)", () => {
    expect(detectSaveIntent("save the game").matched).toBe(true);
  });

  it("matches 'wrap up'", () => {
    expect(detectSaveIntent("let's wrap up here").matched).toBe(true);
  });
});

describe("detectSaveIntent — false-positive guards", () => {
  it("does NOT match 'save this file'", () => {
    expect(detectSaveIntent("save this file").matched).toBe(false);
  });

  it("does NOT match 'save the date'", () => {
    expect(detectSaveIntent("save the date for the meeting").matched).toBe(false);
  });

  it("does NOT match unrelated prompts", () => {
    expect(detectSaveIntent("what does this function do").matched).toBe(false);
    expect(detectSaveIntent("hello").matched).toBe(false);
  });

  it("does NOT match prompts longer than 200 chars (avoid mid-sentence false hits)", () => {
    const long = "I was thinking about what we should do. ".repeat(20) + "save progress";
    expect(detectSaveIntent(long).matched).toBe(false);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

```bash
npm test -- triggers
```

Expected: FAIL — "Cannot find module '../../src/hooks/lib/triggers.js'".

- [ ] **Step 3: Implement triggers.ts**

Create `src/hooks/lib/triggers.ts`:

```typescript
const MAX_PROMPT_LENGTH = 200;

const COMMAND_PATTERN = /^\s*\/checkpoint(?:\s+(.+?))?\s*$/i;

const NL_PATTERNS: RegExp[] = [
  /\bsave\s+(?:the\s+)?progress\b/i,
  /\bsave\s+the\s+game\b/i,
  /\b(?:create|make)\s+a\s+checkpoint\b/i,
  /\bcheckpoint\s+(?:this|here|now)\b/i,
  /\b(?:let'?s\s+)?wrap\s+(?:this\s+)?up\b/i,
  /\bsave\s+(?:our|my)\s+(?:state|context|work)\b/i,
];

export type DetectedIntent =
  | { matched: true; kind: "checkpoint-command"; name?: string; reason: string }
  | { matched: true; kind: "natural-language"; reason: string }
  | { matched: false; kind: "none"; reason: string };

export function detectSaveIntent(prompt: string): DetectedIntent {
  const trimmed = prompt.trim();

  const cmd = COMMAND_PATTERN.exec(trimmed);
  if (cmd) {
    const name = cmd[1]?.trim() || undefined;
    return {
      matched: true,
      kind: "checkpoint-command",
      name,
      reason: name ? "explicit /checkpoint with name" : "explicit /checkpoint",
    };
  }

  if (trimmed.length > MAX_PROMPT_LENGTH) {
    return { matched: false, kind: "none", reason: "prompt too long for natural-language match" };
  }

  for (const pattern of NL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        matched: true,
        kind: "natural-language",
        reason: "matched natural-language pattern",
      };
    }
  }

  return { matched: false, kind: "none", reason: "no save-intent phrase detected" };
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
npm test -- triggers
```

Expected: PASS (12 tests across 3 describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/lib/triggers.ts tests/hooks/triggers.test.ts
git commit -m "feat(hooks): pure save-intent detection module with regex triggers"
```

---

### Task 3: Shared save-handoff helper

**Files:**
- Create: `/home/hyperlynq/synaptic-auto-save/src/hooks/lib/save-handoff.ts`

This wraps the same internal write path that the `context_save` MCP tool uses (`appendEntry` + `ContextIndex.insert` + `insertVec`), so the new hooks don't reimplement it. No tests for this — it's a thin wrapper around already-tested DB code, and integration coverage in the smoke task verifies it end-to-end.

- [ ] **Step 1: Read the existing save flow to confirm signatures**

Read these files to confirm the helper signatures match what's in synaptic:

```bash
sed -n '30,80p' src/tools/context-save.ts
sed -n '37,60p' src/storage/markdown.ts
sed -n '170,210p' src/storage/sqlite.ts
```

Expected: `appendEntry(content, type, tags)` returns `ContextEntry`. `ContextIndex.insert(entry)` returns `number` (rowid). `ContextIndex.insertVec(rowid, embedding)` returns `void`. If any signature differs, update Step 2's code below to match.

- [ ] **Step 2: Implement save-handoff.ts**

Create `src/hooks/lib/save-handoff.ts`:

```typescript
import { appendEntry } from "../../storage/markdown.js";
import { ContextIndex } from "../../storage/sqlite.js";
import { Embedder } from "../../storage/embedder.js";

export interface SaveHandoffArgs {
  content: string;
  tags: string[];
  pinned?: boolean;
}

export async function saveHandoff(args: SaveHandoffArgs): Promise<{ id: string }> {
  const tags = Array.from(new Set(["auto-save", ...args.tags]));
  const entry = appendEntry(args.content, "handoff", tags);
  if (args.pinned) {
    (entry as Record<string, unknown>).pinned = true;
  }

  const index = new ContextIndex();
  const rowid = index.insert(entry);

  try {
    const embedder = new Embedder();
    const embedding = await embedder.embed(args.content);
    index.insertVec(rowid, embedding);
  } catch (err) {
    console.error("[save-handoff] embedding failed (entry still saved):", err);
  }

  return { id: entry.id };
}
```

- [ ] **Step 3: Build to confirm it compiles**

```bash
npm run build
```

Expected: TypeScript compiles cleanly, output appears at `build/src/hooks/lib/save-handoff.js`. If imports resolve to wrong paths, fix based on actual file locations from Step 1.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/lib/save-handoff.ts
git commit -m "feat(hooks): shared save-handoff helper wrapping appendEntry + insert + embed"
```

---

### Task 4: UserPromptSubmit hook implementation + wiring

**Files:**
- Create: `/home/hyperlynq/synaptic-auto-save/src/hooks/user-prompt-submit.ts`
- Modify: `/home/hyperlynq/synaptic-auto-save/src/cli.ts` (add dispatch case)
- Modify: `/home/hyperlynq/synaptic-auto-save/.claude-plugin/hook-launcher.cjs` (add to VALID_HOOKS)
- Modify: `/home/hyperlynq/synaptic-auto-save/.claude-plugin/plugin.json` (register hook)

- [ ] **Step 1: Implement the hook handler**

Create `src/hooks/user-prompt-submit.ts`:

```typescript
import { detectSaveIntent } from "./lib/triggers.js";
import { saveHandoff } from "./lib/save-handoff.js";

interface UserPromptSubmitInput {
  session_id?: string;
  cwd?: string;
  prompt?: string;
  hook_event_name?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runUserPromptSubmit(): Promise<void> {
  const raw = await readStdin();
  let input: UserPromptSubmitInput = {};
  try {
    input = JSON.parse(raw || "{}");
  } catch {
    // Bad JSON from Claude Code — silently exit, never break the user's turn
    return;
  }

  const prompt = input.prompt ?? "";
  if (!prompt) return;

  const intent = detectSaveIntent(prompt);
  if (!intent.matched) return;

  const sessionId = input.session_id ?? "unknown";
  const cwd = input.cwd ?? process.cwd();
  const cwdLabel = cwd.split("/").pop() ?? "unknown";
  const sessionShort = sessionId.slice(0, 8);

  const tags: string[] = [
    intent.kind === "checkpoint-command" ? "trigger:checkpoint-cmd" : "trigger:user-prompt",
    "session:" + sessionShort,
    "cwd:" + cwdLabel,
  ];

  const name =
    intent.kind === "checkpoint-command" && intent.name
      ? intent.name
      : new Date().toISOString().slice(0, 16).replace("T", " ");

  const truncated = prompt.length > 500 ? prompt.slice(0, 500) + "…" : prompt;
  const content = [
    "**Auto-save triggered by user prompt** (" + intent.reason + ")",
    "",
    "**Name:** " + name,
    "**Session:** " + sessionId,
    "**Working dir:** " + cwd,
    "**Original prompt:** " + truncated,
  ].join("\n");

  try {
    const result = await saveHandoff({ content, tags, pinned: intent.kind === "checkpoint-command" });
    process.stdout.write("💾 Saved checkpoint: " + name + " (" + result.id + ")\n");
  } catch (err) {
    console.error("[user-prompt-submit] save failed:", err);
  }
}
```

Note: this module exports `runUserPromptSubmit` only. The CLI dispatcher (Task 4 Step 2) is the sole caller — there is no direct-invocation guard, because the launcher always goes through the dispatcher.

- [ ] **Step 2: Wire CLI dispatch**

Read the CLI file to find where existing hooks dispatch:

```bash
sed -n '60,100p' src/cli.ts
```

Expected output: a switch or if-chain handling `session-start`, `pre-compact`, `stop`. Add a new case for `user-prompt-submit`:

Edit `src/cli.ts`. Find the block that imports and dispatches existing hooks. Add this dispatch case alongside the others (mirror the surrounding pattern):

```typescript
case "user-prompt-submit": {
  const { runUserPromptSubmit } = await import("./hooks/user-prompt-submit.js");
  await runUserPromptSubmit();
  break;
}
```

If `cli.ts` uses dynamic imports keyed by hook name (e.g., a map), add `"user-prompt-submit": "./hooks/user-prompt-submit.js"` to that map instead.

- [ ] **Step 3: Add to launcher VALID_HOOKS**

Edit `.claude-plugin/hook-launcher.cjs`. Find the `VALID_HOOKS` set (~line 34 per the explore). Add `"user-prompt-submit"`:

```javascript
const VALID_HOOKS = new Set([
  "session-start",
  "pre-compact",
  "stop",
  "user-prompt-submit",
]);
```

- [ ] **Step 4: Register the hook in plugin.json**

Edit `.claude-plugin/plugin.json`. Find the `"hooks"` object. Add a new `UserPromptSubmit` entry:

```json
"UserPromptSubmit": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/.claude-plugin/hook-launcher.cjs user-prompt-submit",
        "timeout": 5
      }
    ]
  }
]
```

The 5-second timeout is deliberately tight — the hot path must not stall the user's prompt.

- [ ] **Step 5: Build and run tests**

```bash
npm run build
npm test
```

Expected: build succeeds, all tests still pass (no regressions).

- [ ] **Step 6: Manual integration check**

Without restarting Claude Code (the hook only activates on next session), invoke the launcher directly with synthetic input:

```bash
echo '{"prompt":"save progress","session_id":"test-session-1234","cwd":"/tmp"}' \
  | node .claude-plugin/hook-launcher.cjs user-prompt-submit
```

Expected: stdout contains `💾 Saved checkpoint: ...`. The DB at synaptic's context dir gets a new `handoff` entry tagged `auto-save`, `trigger:user-prompt`, `session:test-ses`, `cwd:tmp`.

Verify via the latest markdown file:

```bash
ls -t ~/.synaptic/context/*.md 2>/dev/null | head -1 | xargs tail -20
```

(Path may differ — check synaptic's `CONTEXT_DIR` env variable or default in `src/storage/markdown.ts`.)

- [ ] **Step 7: Commit**

```bash
git add src/hooks/user-prompt-submit.ts src/cli.ts .claude-plugin/hook-launcher.cjs .claude-plugin/plugin.json
git commit -m "feat(hooks): UserPromptSubmit hook for save-intent triggers"
```

---

## Phase 3: PostToolUse Hook

### Task 5: Pure tool-event classifier + tests

**Files:**
- Create: `/home/hyperlynq/synaptic-auto-save/src/hooks/lib/tool-events.ts`
- Create: `/home/hyperlynq/synaptic-auto-save/tests/hooks/tool-events.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/hooks/tool-events.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { classifyToolEvent } from "../../src/hooks/lib/tool-events.js";

describe("classifyToolEvent — git commit", () => {
  it("matches a git commit Bash invocation with success", () => {
    const r = classifyToolEvent({
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'feat: add foo'" },
      tool_response: { stdout: "[main abc123] feat: add foo\n 1 file changed", stderr: "" },
    });
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("git-commit");
    expect(r!.summary).toMatch(/feat: add foo/);
    expect(r!.tags).toContain("trigger:git-commit");
  });

  it("does not match a non-commit Bash invocation", () => {
    expect(
      classifyToolEvent({
        tool_name: "Bash",
        tool_input: { command: "git status" },
        tool_response: { stdout: "", stderr: "" },
      })
    ).toBeNull();
  });

  it("does not match a failed git commit", () => {
    expect(
      classifyToolEvent({
        tool_name: "Bash",
        tool_input: { command: "git commit -m 'x'" },
        tool_response: { stdout: "", stderr: "nothing to commit, working tree clean" },
      })
    ).toBeNull();
  });
});

describe("classifyToolEvent — plan write", () => {
  it("matches a Write to docs/superpowers/plans/", () => {
    const r = classifyToolEvent({
      tool_name: "Write",
      tool_input: {
        file_path: "/home/user/project/docs/superpowers/plans/2026-04-15-thing.md",
        content: "# Plan",
      },
      tool_response: { type: "create" },
    });
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("plan-write");
    expect(r!.tags).toContain("trigger:plan-write");
  });

  it("does not match a Write to a regular file", () => {
    expect(
      classifyToolEvent({
        tool_name: "Write",
        tool_input: { file_path: "/tmp/note.txt", content: "x" },
        tool_response: { type: "create" },
      })
    ).toBeNull();
  });
});

describe("classifyToolEvent — non-significant tools", () => {
  it("returns null for Read", () => {
    expect(
      classifyToolEvent({
        tool_name: "Read",
        tool_input: { file_path: "/tmp/x" },
        tool_response: { content: "..." },
      })
    ).toBeNull();
  });

  it("returns null for Glob, Grep, etc.", () => {
    expect(
      classifyToolEvent({
        tool_name: "Glob",
        tool_input: { pattern: "*.ts" },
        tool_response: { matches: [] },
      })
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run test — expect failure**

```bash
npm test -- tool-events
```

Expected: FAIL — "Cannot find module '../../src/hooks/lib/tool-events.js'".

- [ ] **Step 3: Implement tool-events.ts**

Create `src/hooks/lib/tool-events.ts`:

```typescript
export interface ToolEventInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: Record<string, unknown>;
}

export interface ClassifiedEvent {
  kind: "git-commit" | "plan-write";
  summary: string;
  tags: string[];
}

export function classifyToolEvent(event: ToolEventInput): ClassifiedEvent | null {
  if (event.tool_name === "Bash") return classifyBash(event);
  if (event.tool_name === "Write") return classifyWrite(event);
  return null;
}

function classifyBash(event: ToolEventInput): ClassifiedEvent | null {
  const command = String(event.tool_input.command ?? "");
  const stdout = String(event.tool_response.stdout ?? "");
  const stderr = String(event.tool_response.stderr ?? "");

  const isCommit = /^\s*git\s+(?:.*\s)?commit\b/.test(command);
  if (!isCommit) return null;

  // Heuristic: a real successful commit prints "[branch hash]" in stdout. Empty stdout
  // or "nothing to commit" stderr means the commit didn't happen.
  if (!/\[[^\]]+\s+[0-9a-f]{6,}\]/.test(stdout)) return null;
  if (/nothing to commit/i.test(stderr) || /nothing to commit/i.test(stdout)) return null;

  const messageMatch = /commit\s+-m\s+["'](.+?)["']/.exec(command);
  const subject = messageMatch ? messageMatch[1] : command.slice(0, 200);
  const hashMatch = /\[[^\]]+\s+([0-9a-f]{6,})\]/.exec(stdout);
  const hash = hashMatch ? hashMatch[1] : "unknown";

  return {
    kind: "git-commit",
    summary: "git commit " + hash + " — " + subject,
    tags: ["trigger:git-commit", "commit:" + hash],
  };
}

function classifyWrite(event: ToolEventInput): ClassifiedEvent | null {
  const path = String(event.tool_input.file_path ?? "");
  if (!path.includes("/docs/superpowers/plans/") || !path.endsWith(".md")) return null;

  const filename = path.split("/").pop() ?? path;
  const planSlug = filename.replace(/\.md$/, "");
  return {
    kind: "plan-write",
    summary: "plan written: " + filename,
    tags: ["trigger:plan-write", "plan:" + planSlug],
  };
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
npm test -- tool-events
```

Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/lib/tool-events.ts tests/hooks/tool-events.test.ts
git commit -m "feat(hooks): pure tool-event classifier for git commits and plan writes"
```

---

### Task 6: PostToolUse hook implementation + wiring

**Files:**
- Create: `/home/hyperlynq/synaptic-auto-save/src/hooks/post-tool-use.ts`
- Modify: `/home/hyperlynq/synaptic-auto-save/src/cli.ts`
- Modify: `/home/hyperlynq/synaptic-auto-save/.claude-plugin/hook-launcher.cjs`
- Modify: `/home/hyperlynq/synaptic-auto-save/.claude-plugin/plugin.json`

- [ ] **Step 1: Implement the hook handler**

Create `src/hooks/post-tool-use.ts`:

```typescript
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
```

- [ ] **Step 2: Wire CLI dispatch**

Edit `src/cli.ts`. Add the `post-tool-use` case alongside the `user-prompt-submit` case from Task 4:

```typescript
case "post-tool-use": {
  const { runPostToolUse } = await import("./hooks/post-tool-use.js");
  await runPostToolUse();
  break;
}
```

- [ ] **Step 3: Add to launcher VALID_HOOKS**

Edit `.claude-plugin/hook-launcher.cjs`. Update the `VALID_HOOKS` set:

```javascript
const VALID_HOOKS = new Set([
  "session-start",
  "pre-compact",
  "stop",
  "user-prompt-submit",
  "post-tool-use",
]);
```

- [ ] **Step 4: Register the hook in plugin.json**

Edit `.claude-plugin/plugin.json`. Add the `PostToolUse` entry alongside the others:

```json
"PostToolUse": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/.claude-plugin/hook-launcher.cjs post-tool-use",
        "timeout": 10
      }
    ]
  }
]
```

The 10s timeout is generous — embedding the summary takes time, but we don't block the next tool call.

- [ ] **Step 5: Build and test**

```bash
npm run build
npm test
```

Expected: build succeeds, all tests pass.

- [ ] **Step 6: Manual integration check**

```bash
echo '{
  "tool_name": "Bash",
  "tool_input": {"command": "git commit -m '\''test'\''"},
  "tool_response": {"stdout": "[main abc1234] test\n 1 file changed", "stderr": ""},
  "session_id": "smoke-1",
  "cwd": "/tmp"
}' | node .claude-plugin/hook-launcher.cjs post-tool-use
```

Expected: hook runs without error, a new `handoff` entry appears with tags including `trigger:git-commit` and `commit:abc1234`.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/post-tool-use.ts src/cli.ts .claude-plugin/hook-launcher.cjs .claude-plugin/plugin.json
git commit -m "feat(hooks): PostToolUse hook for git commits and plan writes"
```

---

## Phase 4: Slash Command

### Task 7: `/checkpoint` slash command

**Files:**
- Create: `/home/hyperlynq/synaptic-auto-save/commands/checkpoint.md`

Claude Code plugins auto-discover slash commands from a top-level `commands/` directory. Each `.md` file becomes a command named after its basename. The body is sent as the user message (with `$ARGUMENTS` substitution) when the command is invoked.

For our case, the command body just emits the literal `/checkpoint <args>` as a plain message — which the `UserPromptSubmit` hook (Task 4) already handles via its `/checkpoint` literal detection. The slash command is purely a discoverability + autocomplete affordance; the actual save still goes through the hook.

- [ ] **Step 1: Create the command file**

Create `commands/checkpoint.md`:

```markdown
---
description: Save a named checkpoint of current progress to Synaptic
argument-hint: "[optional name]"
---

/checkpoint $ARGUMENTS
```

- [ ] **Step 2: Verify command discovery**

Restart Claude Code (or wait for next session — plugins reload on session start). In a fresh session, type `/check` and verify autocomplete suggests `/checkpoint`. Selecting it and pressing Enter should fire the `UserPromptSubmit` hook, which then saves a `handoff` entry tagged `trigger:checkpoint-cmd`.

If the command does not appear in autocomplete, the discovery path may differ. Try moving the file to `.claude-plugin/commands/checkpoint.md` instead. The exact location is plugin-runtime dependent — cross-reference Claude Code plugin docs if the first location fails.

- [ ] **Step 3: Commit**

```bash
git add commands/checkpoint.md
git commit -m "feat(commands): /checkpoint slash command for explicit saves"
```

---

## Phase 5: Packaging & Publish Readiness

**Why this phase exists:** synaptic v1.3.0 shipped with Pattern D — the plugin cache is lightweight (~20KB) and auto-installs the full npm package into `${CLAUDE_PLUGIN_DATA}` on first session. Version drift between `package.json` and `plugin.json` cache-freezes every existing user. New files outside `build/src/` and `.claude-plugin/` (like `commands/`) don't ship unless listed in `files`. This phase closes both gaps before publish.

### Task 8: Add `commands/` to `files` and bump to v1.4.0

**Files:**
- Modify: `/home/hyperlynq/synaptic-auto-save/package.json`
- Modify: `/home/hyperlynq/synaptic-auto-save/.claude-plugin/plugin.json` (version field, via sync script)

- [ ] **Step 1: Add `commands/` to the `files` array**

Edit `package.json`. The current `files` array is:

```json
"files": [
  "build/src/",
  "build/scripts/rebuild-index.js",
  "build/scripts/rebuild-index.d.ts",
  ".claude-plugin/",
  ".mcp.json",
  "scripts/prune-onnxruntime-binaries.cjs",
  "LICENSE",
  "README.md"
]
```

Add `"commands/"` after `".claude-plugin/"`:

```json
"files": [
  "build/src/",
  "build/scripts/rebuild-index.js",
  "build/scripts/rebuild-index.d.ts",
  ".claude-plugin/",
  "commands/",
  ".mcp.json",
  "scripts/prune-onnxruntime-binaries.cjs",
  "LICENSE",
  "README.md"
]
```

- [ ] **Step 2: Bump `package.json` version to 1.4.0**

Edit `package.json`. Change `"version": "1.3.0"` to `"version": "1.4.0"`.

This triggers Pattern D's version-based reinstall on existing users' next session (the `installed.json` marker is keyed on `plugin.json.version`, which we sync next).

- [ ] **Step 3: Sync `plugin.json` version**

Run:

```bash
node scripts/sync-plugin-version.cjs --write
```

Expected output: `sync-plugin-version: updated plugin.json 1.3.0 → 1.4.0`

- [ ] **Step 4: Verify sync without --write in default mode**

```bash
node scripts/sync-plugin-version.cjs
```

Expected output: `sync-plugin-version: OK (1.4.0)`

This is the check `prepublishOnly` runs. It must pass before publish.

- [ ] **Step 5: Commit**

```bash
git add package.json .claude-plugin/plugin.json
git commit -m "chore: bump to v1.4.0 and ship commands/ directory"
```

---

### Task 9: Verify `npm pack --dry-run` includes all new artifacts

**Files:** none (inspection only)

This task catches packaging bugs before publish. If a new required file isn't in the tarball, Pattern D will reinstall from the published npm package and still lack the feature.

- [ ] **Step 1: Build**

```bash
npm run build
```

Expected: clean compile. `build/src/hooks/user-prompt-submit.js`, `build/src/hooks/post-tool-use.js`, and `build/src/hooks/lib/*.js` should all exist.

Verify:

```bash
ls build/src/hooks/user-prompt-submit.js build/src/hooks/post-tool-use.js
ls build/src/hooks/lib/triggers.js build/src/hooks/lib/tool-events.js build/src/hooks/lib/save-handoff.js
```

Expected: all 5 files listed (no "No such file" errors).

- [ ] **Step 2: Run `npm pack --dry-run`**

```bash
npm pack --dry-run 2>&1 | tee /tmp/synaptic-pack.log
```

Expected: the output includes a file listing. Save it for the next step.

- [ ] **Step 3: Verify required files are in the tarball**

Run each of these — every one must print a matching line:

```bash
grep -c 'commands/checkpoint.md' /tmp/synaptic-pack.log
grep -c 'build/src/hooks/user-prompt-submit.js' /tmp/synaptic-pack.log
grep -c 'build/src/hooks/post-tool-use.js' /tmp/synaptic-pack.log
grep -c 'build/src/hooks/lib/triggers.js' /tmp/synaptic-pack.log
grep -c 'build/src/hooks/lib/tool-events.js' /tmp/synaptic-pack.log
grep -c 'build/src/hooks/lib/save-handoff.js' /tmp/synaptic-pack.log
grep -c '.claude-plugin/plugin.json' /tmp/synaptic-pack.log
grep -c '.claude-plugin/hook-launcher.cjs' /tmp/synaptic-pack.log
```

Expected: each command prints `1` (or more). If any print `0`, the file is missing from the tarball — fix the `files` array in `package.json` before proceeding.

- [ ] **Step 4: Check tarball size is sane**

```bash
grep -E 'package size|unpacked size' /tmp/synaptic-pack.log
```

Expected: package size similar to the v1.3.0 tarball (a few MB). If it's suddenly 200MB+, something pulled in unwanted files — investigate.

- [ ] **Step 5: Commit nothing — this is verification only**

No file changes in this task. If any verification failed, fix the underlying issue (usually `files` in `package.json`) and re-run from Step 2.

---

## Phase 6: Verification

### Task 10: End-to-end smoke verification

Run the full chain in a real Claude Code session and confirm saves appear in the expected places.

- [ ] **Step 1: Run all unit tests**

```bash
npm test
```

Expected: all 22 tests pass (sanity: 2, triggers: 12, tool-events: 8).

- [ ] **Step 2: Run existing smoke tests to confirm no regression**

```bash
npm run smoke-test
```

Expected: smoke-test passes. If it fails, investigate before continuing — a regression in the existing context_save flow would also break the new hooks.

- [ ] **Step 3: Build a fresh artifact**

```bash
npm run build
```

Expected: clean build, all new files in `build/src/hooks/` and `build/src/hooks/lib/`.

- [ ] **Step 4: Reload the plugin in Claude Code**

Restart Claude Code so it re-reads `.claude-plugin/plugin.json` and registers the new `UserPromptSubmit` and `PostToolUse` hooks.

- [ ] **Step 5: Live test — natural-language trigger**

In a new Claude Code session, type:

```
save progress
```

Expected:
- The hook fires (visible in Claude Code's hook output / debug logs if available)
- A new `handoff` entry exists in synaptic's storage tagged `auto-save`, `trigger:user-prompt`
- The next session's SessionStart hook surfaces this entry in the "Recent Handoff" block

Verify with:

```bash
sqlite3 ~/.synaptic/context.db "SELECT id, type, tags, substr(content,1,80) FROM entries ORDER BY rowid DESC LIMIT 3;"
```

(Adjust DB path if synaptic stores it elsewhere — check `src/storage/sqlite.ts` for the default location.)

- [ ] **Step 6: Live test — `/checkpoint` slash command**

Type:

```
/checkpoint test-checkpoint-from-smoke
```

Expected: same behavior as Step 5, but the entry's tags include `trigger:checkpoint-cmd` and the content's `**Name:**` line shows `test-checkpoint-from-smoke`. The entry is `pinned: true`.

- [ ] **Step 7: Live test — auto-save on git commit**

In any git repo (e.g., the worktree itself), have Claude run:

```
make a trivial change to README.md and commit it
```

Expected: after the commit succeeds, a new `handoff` entry appears with tags `trigger:git-commit` and `commit:<short-hash>`, summary line `git commit <hash> — <subject>`.

- [ ] **Step 8: Live test — auto-save on plan write**

Have Claude write a plan file:

```
write a 5-line markdown plan to docs/superpowers/plans/2026-04-15-smoke-test.md
```

Expected: a `handoff` entry tagged `trigger:plan-write` and `plan:2026-04-15-smoke-test`.

- [ ] **Step 9: Verify SessionStart recall**

End the session, start a new one. The SessionStart hook output should include the most recent of the handoff entries created in steps 5–8 in the "Recent Handoff" block.

- [ ] **Step 10: Verify no false positives**

In a session, type messages that should NOT trigger saves:

```
save this file please
what does this function do
how do I save the date in JavaScript
```

Expected: no new entries appear in the DB after these prompts. (The "save this file" / "save the date" guards in `triggers.ts` should prevent matches.)

- [ ] **Step 11: Push branch and open PR**

```bash
git push -u origin feat/auto-save-checkpoints
gh pr create --title "feat(v1.4.0): auto-save hooks + /checkpoint command" --body "$(cat <<'EOF'
## Summary
- Adds `UserPromptSubmit` hook that auto-saves `handoff` entries on natural-language triggers ("save progress", etc.) and the literal `/checkpoint` command
- Adds `PostToolUse` hook that auto-saves on successful `git commit` and writes to `docs/superpowers/plans/`
- Adds `/checkpoint [name]` slash command for explicit invocation
- Adds vitest as the project's first unit-test framework (22 unit tests across triggers + tool-events + sanity)
- Bumps to v1.4.0 and ships new `commands/` directory so Pattern D auto-reinstall picks up the new artifacts on existing users' next session

## Test plan
- [ ] `npm test` passes (22 tests)
- [ ] `npm run smoke-test` passes (no regression)
- [ ] `npm pack --dry-run` shows commands/checkpoint.md + build/src/hooks/*.js + build/src/hooks/lib/*.js
- [ ] `node scripts/sync-plugin-version.cjs` exits 0 (versions synced to 1.4.0)
- [ ] Live: typing "save progress" creates a handoff entry
- [ ] Live: `/checkpoint foo` creates a pinned handoff entry named `foo`
- [ ] Live: a successful `git commit` creates a handoff entry tagged `trigger:git-commit`
- [ ] Live: writing a plan file creates a handoff entry tagged `trigger:plan-write`
- [ ] Live: "save this file" does NOT create an entry (false-positive guard)
- [ ] Next session's "Recent Handoff" block surfaces the latest auto-save

## Release steps (post-merge)
1. `npm publish --access public` (WebAuthn 2FA — run in user's own terminal, possibly twice)
2. `git tag v1.4.0 && git push --tags`
3. Restart Claude Code — Pattern D detects version bump and auto-reinstalls 1.4.0 on next session
4. Possibly resubmit to Anthropic marketplace form (like v1.3.0 required)
EOF
)"
```

- [ ] **Step 12: After PR merge — clean up worktree**

```bash
cd /home/hyperlynq/synaptic
git worktree remove ../synaptic-auto-save
git pull origin main
```

---

## Self-Review Notes

**Spec coverage:**
- ✅ Auto-save on user trigger phrases — Task 4 via Task 2
- ✅ Auto-save on git commits — Task 6 via Task 5
- ✅ Auto-save on plan writes — Task 6 via Task 5
- ✅ `/checkpoint [name]` slash command — Task 7
- ✅ No new entry type — uses existing `handoff`
- ✅ Latest save surfaces in SessionStart — inherited from existing hook (no changes)
- ✅ False-positive guards — covered by triggers tests
- ✅ Worktree-safe — Task 0
- ✅ Pattern D install method updated — Task 8 (adds `commands/` to `files`, bumps to v1.4.0, syncs plugin.json version)
- ✅ Packaging verification — Task 9 (`npm pack --dry-run` confirms all new artifacts ship)

**Type consistency:**
- `DetectedIntent` from triggers.ts has fields `matched`, `kind`, `name`, `reason` — consistent across Task 2 and Task 4
- `ClassifiedEvent` from tool-events.ts has fields `kind`, `summary`, `tags` — consistent across Task 5 and Task 6
- `SaveHandoffArgs` (`content`, `tags`, `pinned?`) consistent in Task 3 and Tasks 4/6

**Known fragile points (callout for the implementer):**
1. `commands/checkpoint.md` location — Claude Code's plugin command discovery path may not be `commands/` at root; Task 7 Step 2 has a fallback to `.claude-plugin/commands/`
2. CLI dispatch syntax in `src/cli.ts` — Task 4 Step 2 instructs to mirror the surrounding pattern rather than prescribing exact syntax, because the explore couldn't pin down whether it's a switch statement or a map
3. `appendEntry`/`ContextIndex` signatures — Task 3 Step 1 reads the actual files first to confirm; if they've changed, adapt accordingly

---

## Follow-ups (out of scope)

- **Embedding-based intent detection on UserPromptSubmit hot path** — current v1 is regex only; if false-positive rate is too high (or recall too low), upgrade by reusing `Embedder.classifySentence()` with a debounce (e.g., only call embedder if regex matched a partial pattern)
- **`/checkpoints` and `/load <name>` commands** — multi-checkpoint browser and recall (deferred per user's "latest is enough" framing)
- **Game-style auto-naming** — use intent classifier to generate memorable names like `checkpoint-the-white-hat-boundary` instead of timestamps
- **Project-aware SessionStart panel** — filter recent handoffs by `cwd` so context-switching shows the right project's last save
- **Stop-hook handoff dedup** — when both auto-save and Stop fire near each other, dedup so the SessionStart panel doesn't show three near-identical handoffs
- **Configurable trigger phrases** — let users add their own intent regex patterns via a config file
