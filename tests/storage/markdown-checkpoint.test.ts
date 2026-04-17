import { describe, it, expect } from "vitest";
import { parseMarkdownText } from "../../src/storage/markdown.js";

describe("parseMarkdownText — checkpoint metadata", () => {
  it("parses name/summary/projectRoot/refs/pinned from HTML comments", () => {
    const md = [
      "# Context Log: 2026-04-16",
      "",
      "## 14:00 | checkpoint | rtx-5090-tracker",
      "<!-- id:abc123 -->",
      "<!-- name:rtx-tracker-phase-5-start -->",
      "<!-- summary:Phase 5 kickoff after UI direction locked -->",
      "<!-- projectRoot:/home/u/rtx-5090-tracker -->",
      "<!-- refs:e1,e2,e3 -->",
      "<!-- pinned:1 -->",
      "Full narrative body here.",
      "",
    ].join("\n");
    const entries = parseMarkdownText(md, "/tmp/2026-04-16.md");
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.id).toBe("abc123");
    expect(e.type).toBe("checkpoint");
    expect(e.name).toBe("rtx-tracker-phase-5-start");
    expect(e.summary).toBe("Phase 5 kickoff after UI direction locked");
    expect(e.projectRoot).toBe("/home/u/rtx-5090-tracker");
    expect(e.referencedEntryIds).toEqual(["e1", "e2", "e3"]);
    expect(e.pinned).toBe(true);
    expect(e.content).toBe("Full narrative body here.");
  });

  it("leaves new fields undefined for v1.4.0 entries without the comments", () => {
    const md = [
      "# Context Log: 2026-04-16",
      "",
      "## 14:00 | handoff | x",
      "<!-- id:xyz -->",
      "Just content.",
      "",
    ].join("\n");
    const entries = parseMarkdownText(md, "/tmp/x.md");
    expect(entries[0].name).toBeUndefined();
    expect(entries[0].projectRoot).toBeUndefined();
    expect(entries[0].referencedEntryIds).toBeUndefined();
  });
});
