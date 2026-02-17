/**
 * Shared utilities for rule enforcement.
 * Used by commit-msg hook, stop hook, and smoke tests.
 */

/**
 * Extract check patterns from a rule's content.
 * Looks for:
 * 1. Quoted strings → extract as literal patterns
 * 2. Negative rules ("never/don't/do not [verb] X") → extract the forbidden term
 */
export function extractCheckPatterns(ruleContent: string): string[] {
  const patterns: string[] = [];

  // 1. Extract double-quoted strings
  const doubleQuoted = ruleContent.matchAll(/"([^"]+)"/g);
  for (const m of doubleQuoted) {
    const inner = m[1].trim();
    if (inner.length >= 2) {
      patterns.push(inner);
    }
  }

  // 2. Extract single-quoted strings (skip apostrophes in contractions like don't/can't)
  const singleQuoted = ruleContent.matchAll(/(?:^|[\s(])'([^']+)'/g);
  for (const m of singleQuoted) {
    const inner = m[1].trim();
    if (inner.length >= 2 && !patterns.some(p => p.toLowerCase() === inner.toLowerCase())) {
      patterns.push(inner);
    }
  }

  // 3. Extract forbidden terms from negative rules
  // Matches: "never/don't/do not/must not/should not [verb] [term]"
  const negativePattern = /\b(?:never|don't|do\s+not|must\s+not|should\s+not|cannot|can't)\s+(?:\w+\s+)?(.+)/gi;
  let match: RegExpExecArray | null;
  while ((match = negativePattern.exec(ruleContent)) !== null) {
    const rest = match[1].trim();
    // Take the meaningful noun phrase — stop at sentence boundaries
    const term = rest.replace(/[.!,;].*$/, "").trim();
    if (term.length >= 2 && !patterns.some(p => p.toLowerCase() === term.toLowerCase())) {
      patterns.push(term);
    }
  }

  return patterns;
}

/**
 * Check a message against extracted patterns (case-insensitive substring match).
 * Returns the first matching pattern, or null if clean.
 */
export function checkMessageAgainstPatterns(
  message: string,
  patterns: string[]
): string | null {
  const lower = message.toLowerCase();
  for (const pattern of patterns) {
    if (lower.includes(pattern.toLowerCase())) {
      return pattern;
    }
  }
  return null;
}
