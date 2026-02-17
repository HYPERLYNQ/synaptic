import { randomBytes } from "node:crypto";

let cachedSessionId: string | null = null;

export function getSessionId(): string {
  if (cachedSessionId) return cachedSessionId;

  // Check env var first (Claude Code may expose this)
  const envSession = process.env.CLAUDE_SESSION_ID ?? process.env.SESSION_ID;
  if (envSession) {
    cachedSessionId = envSession;
    return cachedSessionId;
  }

  // Fallback: cryptographically random session ID
  cachedSessionId = randomBytes(8).toString("hex");
  return cachedSessionId;
}
