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
