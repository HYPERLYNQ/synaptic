export interface ToolEventInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: Record<string, unknown>;
}

export interface ClassifiedEvent {
  kind: "git-commit" | "plan-write" | "spec-write";
  summary: string;
  name: string;
  tags: string[];
  dedupeKey: string;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function classifyToolEvent(event: ToolEventInput): ClassifiedEvent | null {
  if (event.tool_name === "Bash") return classifyBash(event);
  if (event.tool_name === "Write" || event.tool_name === "Edit") return classifyFileWrite(event);
  return null;
}

function classifyBash(event: ToolEventInput): ClassifiedEvent | null {
  const command = String(event.tool_input.command ?? "");
  const stdout = String(event.tool_response.stdout ?? "");
  const stderr = String(event.tool_response.stderr ?? "");

  const isCommit = /^\s*git\s+(?:.*\s)?commit\b/.test(command);
  if (!isCommit) return null;

  if (/--amend\b/.test(command)) return null;
  if (/\s-i\b/.test(command) || /\s--interactive\b/.test(command)) return null;
  if (/nothing to commit/i.test(stderr) || /nothing to commit/i.test(stdout)) return null;

  const stdoutMatch = /\[[^\]]+\s+([0-9a-f]{6,})\]\s*(.*)/.exec(stdout);
  if (!stdoutMatch) return null;
  const hash = stdoutMatch[1];
  const subject = stdoutMatch[2].trim() || command.slice(0, 200);
  const name = slugify(subject);

  return {
    kind: "git-commit",
    summary: "git commit " + hash + " — " + subject,
    name,
    tags: ["trigger:git-commit", "commit:" + hash],
    dedupeKey: "sha:" + hash,
  };
}

function classifyFileWrite(event: ToolEventInput): ClassifiedEvent | null {
  const path = String(event.tool_input.file_path ?? "");
  if (!path.endsWith(".md")) return null;

  const isPlan = path.includes("/docs/superpowers/plans/");
  const isSpec = path.includes("/docs/superpowers/specs/");
  if (!isPlan && !isSpec) return null;

  const filename = path.split("/").pop() ?? path;
  const base = filename.replace(/\.md$/, "").replace(/^\d{4}-\d{2}-\d{2}-/, "");
  const name = slugify(base);

  const kind: "plan-write" | "spec-write" = isPlan ? "plan-write" : "spec-write";
  const tagPrefix = isPlan ? "plan:" : "spec:";
  const triggerTag = isPlan ? "trigger:plan-write" : "trigger:spec-write";

  return {
    kind,
    summary: (isPlan ? "plan written: " : "spec written: ") + filename,
    name,
    tags: [triggerTag, tagPrefix + base],
    dedupeKey: "path:" + path,
  };
}
