/**
 * Regex-based signal scoring — boost layer for semantic classification.
 *
 * This module does NOT decide what gets saved. It provides a signal boost
 * score that gets added to the semantic similarity. Even if signal score
 * is 0, a message can still be captured purely through semantic anchor matching.
 */

export interface SignalResult {
  total: number;          // weighted sum of all signal hits
  dominant: string;       // highest-scoring axis name
  signals: Record<string, number>; // per-axis raw scores
}

interface SignalAxis {
  name: string;
  weight: number;
  pattern: RegExp;
}

const AXES: SignalAxis[] = [
  {
    name: "directive",
    weight: 1.0,
    pattern: /\b(always|never|must|should|have to|need to|keep|make sure|ensure|maintain|don't ever)\b/gi,
  },
  {
    name: "preference",
    weight: 0.8,
    pattern: /\b(I like|I prefer|I want|I don't like|I hate|I love|looks nice|looks good|looks great|rather|instead of)\b/gi,
  },
  {
    name: "evaluative",
    weight: 0.6,
    pattern: /\b(works|broken|good|bad|ugly|clean|messy|better|worse|perfect|sucks|terrible|amazing)\b/gi,
  },
  {
    name: "decisional",
    weight: 0.9,
    pattern: /\b(let's use|go with|chose|picked|decided|recommend|we'll use|try this)\b/gi,
  },
  {
    name: "temporal",
    weight: 0.7,
    pattern: /\b(from now on|going forward|every time|whenever|in the future|across all|throughout)\b/gi,
  },
  {
    name: "identity",
    weight: 0.8,
    pattern: /\b(my project|my app|I built|I own|is called|my repo|belongs to me)\b/gi,
  },
  {
    name: "emotional",
    weight: 0.7,
    pattern: /\b(love|hate|annoying|frustrating|amazing|terrible|excited|angry|sucks|awesome|damn)\b/gi,
  },
  {
    name: "consistency",
    weight: 0.9,
    pattern: /\b(consistent|match|same as|align|standardize|uniform|everywhere)\b/gi,
  },
];

export function scoreSignals(text: string): SignalResult {
  const signals: Record<string, number> = {};
  let bestAxis = "";
  let bestScore = 0;
  let total = 0;

  for (const axis of AXES) {
    const matches = text.match(axis.pattern);
    const count = matches ? matches.length : 0;
    // raw score = count * weight, capped at weight * 2
    const raw = Math.min(count * axis.weight, axis.weight * 2);
    signals[axis.name] = raw;
    total += raw;

    if (raw > bestScore) {
      bestScore = raw;
      bestAxis = axis.name;
    }
  }

  return {
    total,
    dominant: bestAxis || "none",
    signals,
  };
}
