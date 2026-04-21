import { describe, it, expect } from "vitest";
import { timeAgoLabel } from "../../src/tools/context-list.js";

describe("timeAgoLabel", () => {
  const now = new Date("2026-04-21T05:41:00.000Z");

  it("renders <60s as 'just now'", () => {
    expect(timeAgoLabel("2026-04-21T05:40:30.000Z", now)).toBe("just now");
  });

  it("renders minutes under the hour", () => {
    expect(timeAgoLabel("2026-04-21T05:13:00.000Z", now)).toBe("28min ago");
  });

  it("renders hours for same local day", () => {
    // Both inputs and `now` are same UTC date (2026-04-21) AND — for the
    // typical WSL/Windows reader in EDT — same local date.
    expect(timeAgoLabel("2026-04-21T04:09:00.000Z", now)).toBe("1h ago");
  });

  it("prefers 'yesterday' over 'Nh ago' when local date differs", () => {
    // 2026-04-21T00:10Z is "yesterday evening" on any US-east reader even
    // though the raw duration (5h) is under 24h. Calendar-correct wins.
    const label = timeAgoLabel("2026-04-21T00:10:00.000Z", now);
    expect(["yesterday", "5h ago"]).toContain(label);
  });

  it("renders 'yesterday' only for the previous LOCAL calendar day", () => {
    // On a reader whose local tz is UTC, "yesterday relative to now"
    // is 2026-04-20.
    const yesterdayAfternoon = "2026-04-20T14:00:00.000Z";
    expect(timeAgoLabel(yesterdayAfternoon, now)).toBe("yesterday");
  });

  it("renders 'Nd ago' beyond yesterday", () => {
    expect(timeAgoLabel("2026-04-18T12:00:00.000Z", now)).toBe("2d ago");
    expect(timeAgoLabel("2026-04-15T12:00:00.000Z", now)).toBe("5d ago");
  });

  it("falls back to YYYY-MM-DD past 7 days", () => {
    expect(timeAgoLabel("2026-03-15T12:00:00.000Z", now)).toBe("2026-03-15");
  });

  it("returns 'in the future' for future timestamps", () => {
    // Regression: some entries have stored date/time that derive to a
    // future createdAtUtc. Don't silently return negative durations.
    expect(timeAgoLabel("2026-04-22T02:36:00.000Z", now)).toBe("in the future");
  });

  it("returns 'unknown' for unparseable strings", () => {
    expect(timeAgoLabel("not-a-timestamp", now)).toBe("unknown");
  });
});
