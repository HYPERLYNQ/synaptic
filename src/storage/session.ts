import { createHash } from "node:crypto";

let cachedSessionId: string | null = null;

export function getSessionId(): string {
  if (cachedSessionId) return cachedSessionId;

  // Check env var first (Claude Code may expose this)
  const envSession = process.env.CLAUDE_SESSION_ID ?? process.env.SESSION_ID;
  if (envSession) {
    cachedSessionId = envSession;
    return cachedSessionId;
  }

  // Fallback: hash of pid + ppid + start time
  const raw = `${process.pid}-${process.ppid}-${Date.now()}`;
  cachedSessionId = createHash("sha256").update(raw).digest("hex").slice(0, 12);
  return cachedSessionId;
}
