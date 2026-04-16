// 200 is deliberately generous: save-intent phrases in practice are < 60 chars,
// but a short quoted snippet in a longer question (e.g. "why does 'save progress'
// not trigger?") shouldn't be treated as real intent. 200 blocks mid-paragraph
// false hits without clipping realistic explicit triggers.
const MAX_PROMPT_LENGTH = 200;

const COMMAND_PATTERN = /^\/checkpoint(?:\s+(.+?))?$/i;

// Each pattern must describe an unambiguous save intent. Patterns like "wrap up"
// and "save my state/work" were considered but dropped: they fire on ordinary
// Claude conversation ("please wrap up your response", "save my work in progress")
// and the false-positive cost outweighs the marginal recall benefit. Users who
// want those can always type `/checkpoint` explicitly.
const NL_PATTERNS: RegExp[] = [
  /\bsave\s+(?:the\s+)?progress\b/i,
  /\bsave\s+the\s+game\b/i,
  /\b(?:create|make)\s+a\s+checkpoint\b/i,
  /\bcheckpoint\s+(?:this|here|now)\b/i,
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
