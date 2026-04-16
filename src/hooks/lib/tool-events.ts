export interface ToolEventInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: Record<string, unknown>;
}

export interface ClassifiedEvent {
  kind: "git-commit" | "plan-write";
  summary: string;
  tags: string[];
}

export function classifyToolEvent(event: ToolEventInput): ClassifiedEvent | null {
  if (event.tool_name === "Bash") return classifyBash(event);
  if (event.tool_name === "Write") return classifyWrite(event);
  return null;
}

function classifyBash(event: ToolEventInput): ClassifiedEvent | null {
  const command = String(event.tool_input.command ?? "");
  const stdout = String(event.tool_response.stdout ?? "");
  const stderr = String(event.tool_response.stderr ?? "");

  const isCommit = /^\s*git\s+(?:.*\s)?commit\b/.test(command);
  if (!isCommit) return null;

  // Heuristic: a real successful commit prints "[branch hash]" in stdout. Empty stdout
  // or "nothing to commit" stderr means the commit didn't happen.
  if (!/\[[^\]]+\s+[0-9a-f]{6,}\]/.test(stdout)) return null;
  if (/nothing to commit/i.test(stderr) || /nothing to commit/i.test(stdout)) return null;

  const messageMatch = /commit\s+-m\s+["'](.+?)["']/.exec(command);
  const subject = messageMatch ? messageMatch[1] : command.slice(0, 200);
  const hashMatch = /\[[^\]]+\s+([0-9a-f]{6,})\]/.exec(stdout);
  const hash = hashMatch ? hashMatch[1] : "unknown";

  return {
    kind: "git-commit",
    summary: "git commit " + hash + " — " + subject,
    tags: ["trigger:git-commit", "commit:" + hash],
  };
}

function classifyWrite(event: ToolEventInput): ClassifiedEvent | null {
  const path = String(event.tool_input.file_path ?? "");
  if (!path.includes("/docs/superpowers/plans/") || !path.endsWith(".md")) return null;

  const filename = path.split("/").pop() ?? path;
  const planSlug = filename.replace(/\.md$/, "");
  return {
    kind: "plan-write",
    summary: "plan written: " + filename,
    tags: ["trigger:plan-write", "plan:" + planSlug],
  };
}
