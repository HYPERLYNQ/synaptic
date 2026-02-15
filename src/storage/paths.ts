import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

const BASE_DIR = join(homedir(), ".claude-context");
export const CONTEXT_DIR = join(BASE_DIR, "context");
export const DB_DIR = join(BASE_DIR, "db");
export const DB_PATH = join(DB_DIR, "context.db");
export const MODELS_DIR = join(BASE_DIR, "models");

export function ensureDirs(): void {
  mkdirSync(CONTEXT_DIR, { recursive: true });
  mkdirSync(DB_DIR, { recursive: true });
  mkdirSync(MODELS_DIR, { recursive: true });
}

export function dateToFilePath(date: string): string {
  return join(CONTEXT_DIR, `${date}.md`);
}
