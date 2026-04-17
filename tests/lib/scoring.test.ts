import { describe, it, expect } from "vitest";
import { rankEntries, scoreEntry, type RankInput } from "../../src/lib/scoring.js";

function makeEntry(overrides: Partial<RankInput> = {}): RankInput {
  return {
    id: "e1",
    content: "x".repeat(500),
    projectRoot: null,
    tags: [],
    pinned: false,
    createdAtMs: Date.now(),
    ...overrides,
  };
}

describe("scoreEntry", () => {
  it("maxes content-length component at 500 chars", () => {
    const short = scoreEntry(makeEntry({ content: "x".repeat(250) }), null);
    const long  = scoreEntry(makeEntry({ content: "x".repeat(5000) }), null);
    expect(long.breakdown.length).toBe(0.35 * 1.0);
    expect(short.breakdown.length).toBeCloseTo(0.35 * 0.5, 5);
  });

  it("gives 0.35 project-match for exact projectRoot equality", () => {
    const matched = scoreEntry(
      makeEntry({ projectRoot: "/home/u/proj" }),
      "/home/u/proj"
    );
    expect(matched.breakdown.project).toBeCloseTo(0.35, 5);
  });

  it("gives 0.35*0.3 project-match for tag overlap only", () => {
    const tagOverlap = scoreEntry(
      makeEntry({ projectRoot: null, tags: ["rtx-5090-tracker"] }),
      "/home/u/rtx-5090-tracker"
    );
    expect(tagOverlap.breakdown.project).toBeCloseTo(0.35 * 0.3, 5);
  });

  it("gives 0 project-match when no signal matches", () => {
    const none = scoreEntry(makeEntry(), "/home/u/other");
    expect(none.breakdown.project).toBe(0);
  });

  it("adds 0.15 for pinned entries", () => {
    const unpinned = scoreEntry(makeEntry({ pinned: false }), null);
    const pinned   = scoreEntry(makeEntry({ pinned: true  }), null);
    expect(pinned.breakdown.pinned - unpinned.breakdown.pinned).toBeCloseTo(0.15, 5);
  });

  it("applies 3-day half-life recency decay", () => {
    const now = Date.now();
    const fresh = scoreEntry(makeEntry({ createdAtMs: now }), null);
    const old72 = scoreEntry(makeEntry({ createdAtMs: now - 72 * 3600 * 1000 }), null);
    expect(fresh.breakdown.recency).toBeCloseTo(0.15, 5);
    expect(old72.breakdown.recency).toBeCloseTo(0.15 / Math.E, 4);
  });
});

describe("rankEntries", () => {
  it("sorts entries by descending score", () => {
    const entries = [
      makeEntry({ id: "a", content: "short",       pinned: false, projectRoot: null          }),
      makeEntry({ id: "b", content: "x".repeat(5000), pinned: true,  projectRoot: "/p"       }),
      makeEntry({ id: "c", content: "x".repeat(500), pinned: false, projectRoot: "/p"        }),
    ];
    const ranked = rankEntries(entries, "/p");
    expect(ranked.map(r => r.id)).toEqual(["b", "c", "a"]);
  });

  it("is stable for ties (preserves input order)", () => {
    const t = Date.now();
    const entries = [
      makeEntry({ id: "a", createdAtMs: t, content: "x".repeat(500), projectRoot: "/p" }),
      makeEntry({ id: "b", createdAtMs: t, content: "x".repeat(500), projectRoot: "/p" }),
    ];
    const ranked = rankEntries(entries, "/p");
    expect(ranked.map(r => r.id)).toEqual(["a", "b"]);
  });
});
