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

  it("matches 'save the game' (game-style)", () => {
    expect(detectSaveIntent("save the game").matched).toBe(true);
  });

  it("matches 'create a checkpoint'", () => {
    expect(detectSaveIntent("create a checkpoint").matched).toBe(true);
  });

  it("matches 'make a checkpoint'", () => {
    expect(detectSaveIntent("make a checkpoint").matched).toBe(true);
  });

  it("matches 'checkpoint this'", () => {
    expect(detectSaveIntent("checkpoint this").matched).toBe(true);
  });

  it("matches 'checkpoint here'", () => {
    expect(detectSaveIntent("checkpoint here").matched).toBe(true);
  });

  it("matches 'checkpoint now'", () => {
    expect(detectSaveIntent("checkpoint now").matched).toBe(true);
  });
});

describe("detectSaveIntent — false-positive guards", () => {
  it("does NOT match 'save this file'", () => {
    expect(detectSaveIntent("save this file").matched).toBe(false);
  });

  it("does NOT match 'save the date'", () => {
    expect(detectSaveIntent("save the date for the meeting").matched).toBe(false);
  });

  it("does NOT match 'wrap up your response' (dropped wrap-up pattern)", () => {
    expect(detectSaveIntent("please wrap up your response").matched).toBe(false);
    expect(detectSaveIntent("let's wrap up here").matched).toBe(false);
  });

  it("does NOT match 'save my work/state' (dropped save-my-state pattern)", () => {
    expect(detectSaveIntent("save my work in progress").matched).toBe(false);
    expect(detectSaveIntent("I need to save my state of mind").matched).toBe(false);
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
