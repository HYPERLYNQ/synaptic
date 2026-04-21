import { describe, it, expect } from "vitest";
import { toSyncable, fromSyncable } from "../../src/storage/sync.js";
import type { ContextEntry } from "../../src/storage/markdown.js";

/**
 * v1.7.3 regression tests — earlier versions silently dropped projectRoot,
 * name, summary, and referencedEntryIds during sync. Checkpoints crossing
 * the boundary ended up invisible to /list-checkpoints (which filters by
 * project_root) and nameless in the UI.
 */
describe("sync serialization — v1.7.3 full-fidelity roundtrip", () => {
  const baseEntry: ContextEntry = {
    id: "test123abc",
    date: "2026-04-21",
    time: "00:17",
    type: "checkpoint",
    tags: ["checkpoint", "auto-save"],
    content: "example checkpoint content",
    sourceFile: "/tmp/ctx.md",
    tier: "longterm",
    pinned: false,
    project: "hotship",
    sessionId: "sess-42",
    agentId: null,
    projectRoot: "/home/hyperlynq/shippo-label",
    name: "polish-name-fields",
    summary: "Balanced First/Last, Middle behind reveal",
    referencedEntryIds: ["ref1", "ref2"],
  };

  it("preserves projectRoot through toSyncable → fromSyncable", () => {
    const wire = toSyncable(baseEntry);
    expect(wire.projectRoot).toBe("/home/hyperlynq/shippo-label");

    const received = fromSyncable(wire);
    expect(received.projectRoot).toBe("/home/hyperlynq/shippo-label");
  });

  it("preserves name and summary", () => {
    const wire = toSyncable(baseEntry);
    expect(wire.name).toBe("polish-name-fields");
    expect(wire.summary).toBe("Balanced First/Last, Middle behind reveal");

    const received = fromSyncable(wire);
    expect(received.name).toBe("polish-name-fields");
    expect(received.summary).toBe("Balanced First/Last, Middle behind reveal");
  });

  it("preserves referencedEntryIds", () => {
    const wire = toSyncable(baseEntry);
    expect(wire.referencedEntryIds).toEqual(["ref1", "ref2"]);

    const received = fromSyncable(wire);
    expect(received.referencedEntryIds).toEqual(["ref1", "ref2"]);
  });

  it("emits an ISO8601 UTC createdAtUtc from local date+time", () => {
    const wire = toSyncable(baseEntry);
    // `00:17` is local tz; its UTC equivalent depends on the test runner's
    // tz, so we just assert the shape: YYYY-MM-DDTHH:MM:SS.sssZ
    expect(wire.createdAtUtc).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
  });

  it("tolerates pre-v1.7.3 wire format — missing fields come back undefined", () => {
    // Simulate a SyncableEntry from an older machine: projectRoot/name/summary
    // aren't present on the JSON line at all.
    const legacy = {
      id: "legacyId",
      date: "2026-04-20",
      time: "13:00",
      type: "checkpoint",
      tags: ["checkpoint"],
      content: "legacy content",
      tier: "working",
      pinned: false,
      project: "hotship",
      sessionId: null,
      agentId: null,
    };
    const received = fromSyncable(legacy);
    expect(received.projectRoot).toBeUndefined();
    expect(received.name).toBeUndefined();
    expect(received.summary).toBeUndefined();
    expect(received.referencedEntryIds).toBeUndefined();
    // Core fields still come through.
    expect(received.id).toBe("legacyId");
    expect(received.project).toBe("hotship");
  });

  it("omits createdAtUtc when date/time are unparseable", () => {
    const wire = toSyncable({ ...baseEntry, date: "not-a-date", time: "??" });
    expect(wire.createdAtUtc).toBeUndefined();
  });

  it("accepts HH:MM:SS time format too", () => {
    const wire = toSyncable({ ...baseEntry, time: "00:17:42" });
    expect(wire.createdAtUtc).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
  });

  it("null projectRoot/name/summary do not become non-null on roundtrip", () => {
    const sparseEntry: ContextEntry = {
      ...baseEntry,
      projectRoot: undefined,
      name: undefined,
      summary: undefined,
      referencedEntryIds: undefined,
    };
    const wire = toSyncable(sparseEntry);
    // Explicit null on the wire (conservative default; older format)
    expect(wire.projectRoot).toBeNull();
    expect(wire.name).toBeNull();
    expect(wire.summary).toBeNull();

    const received = fromSyncable(wire);
    // Receiver drops null back to undefined so the SQLite insert writes NULL.
    expect(received.projectRoot).toBeUndefined();
    expect(received.name).toBeUndefined();
    expect(received.summary).toBeUndefined();
  });
});
