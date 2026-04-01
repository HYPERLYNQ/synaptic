/**
 * Query expansion utilities for intelligent FTS5 search.
 *
 * Provides typo tolerance via edit-distance-1 deletions and stop word
 * filtering.  Porter stemming is already handled by the FTS5 tokenizer
 * (`tokenize='porter unicode61'`), so we do NOT duplicate it here.
 */

export const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "as", "be", "was", "were",
  "been", "are", "am", "do", "did", "does", "has", "have", "had",
  "not", "no", "nor", "so", "if", "than", "that", "this", "then",
  "when", "what", "which", "who", "how", "all", "each", "every",
  "both", "few", "more", "most", "other", "some", "such", "only",
  "own", "same", "too", "very", "can", "will", "just", "should",
  "now", "its", "my", "our", "your", "his", "her", "their",
]);

export interface ExpandedConcept {
  original: string;
  variations: string[];
}

/**
 * Generate edit-distance-1 deletions for a term.
 * Only applies to terms with 4+ characters — shorter terms produce
 * too many false-positive variants.  Each deletion removes one character,
 * so every variant has length `term.length - 1` (>= 3).
 */
export function fuzzyDeletions(term: string): string[] {
  if (term.length < 4) return [];

  const seen = new Set<string>();
  const results: string[] = [];

  for (let i = 0; i < term.length; i++) {
    const variant = term.slice(0, i) + term.slice(i + 1);
    if (!seen.has(variant)) {
      seen.add(variant);
      results.push(variant);
    }
  }

  return results;
}

/**
 * Expand a raw user query into a list of ExpandedConcept objects.
 *
 * 1. Strip special / punctuation characters
 * 2. Lowercase and split into terms
 * 3. Filter out stop words
 * 4. Generate fuzzy deletion variants per term
 */
export function expandQuery(query: string): ExpandedConcept[] {
  // Strip anything that is not alphanumeric, whitespace, or hyphen
  const cleaned = query.replace(/[^a-zA-Z0-9\s-]/g, " ");

  const terms = cleaned
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));

  // Deduplicate terms while preserving order
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const t of terms) {
    if (!seen.has(t)) {
      seen.add(t);
      unique.push(t);
    }
  }

  return unique.map((term) => ({
    original: term,
    variations: fuzzyDeletions(term),
  }));
}

/**
 * Convert an ExpandedConcept into an FTS5 MATCH expression fragment.
 *
 * Each term (original + fuzzy variants) is double-quoted and joined
 * with OR so any variant can match:
 *
 *   { original: "fever", variations: ["ever", "fver", "feer", "fevr", "feve"] }
 *   => `"fever" OR "ever" OR "fver" OR "feer" OR "fevr" OR "feve"`
 *
 * For short words with no variants the output is just `"fix"`.
 */
export function conceptToFts5(concept: ExpandedConcept): string {
  const all = [concept.original, ...concept.variations];
  return all.map((t) => `"${t}"`).join(" OR ");
}
