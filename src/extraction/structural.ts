/**
 * Structural parser for tool output pattern matching.
 * Pattern-matches known output shapes from tool_result blocks
 * to extract project facts without needing an LLM.
 */

import type { ToolResultEntry } from "../storage/transcript.js";

export interface ExtractionSnippet {
  pattern:
    | "python_dict"
    | "sql_columns"
    | "attribute_error"
    | "key_error"
    | "route_pattern"
    | "env_var"
    | "docker_command";
  raw: string;
  summary: string;
}

/**
 * Match Python dict literals with single-quoted keys (3+ keys).
 * e.g. `{'name': 'Alice', 'age': 30, 'email': 'a@b.com'}`
 */
function matchPythonDicts(text: string): ExtractionSnippet[] {
  const snippets: ExtractionSnippet[] = [];
  // Match Python dict-like structures: { 'key': value, ... } or { "key": value, ... }
  const dictRegex = /\{[^{}]*(?:'[^']+'\s*:|"[^"]+"\s*:)[^{}]*\}/g;
  let match: RegExpExecArray | null;

  while ((match = dictRegex.exec(text)) !== null) {
    const raw = match[0];
    // Extract single-quoted or double-quoted keys
    const keyRegex = /(?:'([^']+)'|"([^"]+)")\s*:/g;
    const keys: string[] = [];
    let keyMatch: RegExpExecArray | null;
    while ((keyMatch = keyRegex.exec(raw)) !== null) {
      keys.push(keyMatch[1] ?? keyMatch[2]);
    }
    if (keys.length < 3) continue;

    // SECURITY: Don't include full dict in raw (values may contain secrets).
    // Only pass the key structure to avoid leaking credential values.
    snippets.push({
      pattern: "python_dict",
      raw: `{${keys.map(k => `'${k}': ...`).join(", ")}}`,
      summary: `Python dict with fields: ${keys.join(", ")}`,
    });
  }

  return snippets;
}

/**
 * Match SQL SELECT statements and extract table + column names.
 * e.g. `SELECT id, name, email FROM users`
 */
function matchSqlSelects(text: string): ExtractionSnippet[] {
  const snippets: ExtractionSnippet[] = [];
  const sqlRegex =
    /SELECT\s+([^;]*?)\s+FROM\s+([a-zA-Z_][a-zA-Z0-9_.]*)/gi;
  let match: RegExpExecArray | null;

  while ((match = sqlRegex.exec(text)) !== null) {
    const columnsRaw = match[1];
    const tableName = match[2];
    // Split columns by comma, trim whitespace, filter out empty
    const columns = columnsRaw
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c.length > 0 && c !== "*");

    const raw = match[0];
    if (columns.length > 0) {
      snippets.push({
        pattern: "sql_columns",
        raw,
        summary: `SQL table "${tableName}" with columns: ${columns.join(", ")}`,
      });
    } else {
      // SELECT * FROM table
      snippets.push({
        pattern: "sql_columns",
        raw,
        summary: `SQL query on table "${tableName}"`,
      });
    }
  }

  return snippets;
}

/**
 * Match Python AttributeError messages.
 * e.g. `AttributeError: type object 'User' has no attribute 'email'`
 */
function matchAttributeErrors(text: string): ExtractionSnippet[] {
  const snippets: ExtractionSnippet[] = [];
  const attrRegex =
    /AttributeError:\s*type object '([^']+)' has no attribute '([^']+)'/g;
  let match: RegExpExecArray | null;

  while ((match = attrRegex.exec(text)) !== null) {
    const modelName = match[1];
    const missingField = match[2];
    snippets.push({
      pattern: "attribute_error",
      raw: match[0],
      summary: `AttributeError: "${modelName}" missing attribute "${missingField}"`,
    });
  }

  return snippets;
}

/**
 * Match Python KeyError messages.
 * e.g. `KeyError: 'database_url'`
 */
function matchKeyErrors(text: string): ExtractionSnippet[] {
  const snippets: ExtractionSnippet[] = [];
  const keyRegex = /KeyError:\s*'([^']+)'/g;
  let match: RegExpExecArray | null;

  while ((match = keyRegex.exec(text)) !== null) {
    const missingKey = match[1];
    snippets.push({
      pattern: "key_error",
      raw: match[0],
      summary: `KeyError: missing key "${missingKey}"`,
    });
  }

  return snippets;
}

/**
 * Match route/auth patterns with surrounding context.
 * Looks for: <ProtectedRoute, <AuthRoute, requireAuth, isAuthenticated, authMiddleware
 */
function matchRoutePatterns(text: string): ExtractionSnippet[] {
  const snippets: ExtractionSnippet[] = [];
  const seen = new Set<string>();
  const routeRegex =
    /<ProtectedRoute|<AuthRoute|requireAuth|isAuthenticated|authMiddleware/g;
  let match: RegExpExecArray | null;

  while ((match = routeRegex.exec(text)) !== null) {
    const key = match[0];
    if (seen.has(key)) continue;
    seen.add(key);

    const matchStart = match.index;
    const contextStart = Math.max(0, matchStart - 100);
    const contextEnd = Math.min(text.length, matchStart + match[0].length + 100);
    const raw = text.slice(contextStart, contextEnd);

    snippets.push({
      pattern: "route_pattern",
      raw,
      summary: `Auth/route pattern: "${key}" found in tool output`,
    });
  }

  return snippets;
}

/**
 * Match environment variable references.
 * Looks for patterns like: process.env.VAR, os.environ["VAR"], ${VAR}, $VAR in config contexts,
 * .env file contents (KEY=value lines).
 */
function matchEnvVars(text: string): ExtractionSnippet[] {
  const snippets: ExtractionSnippet[] = [];
  const seen = new Set<string>();

  // process.env.VAR_NAME
  const nodeEnvRegex = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
  let match: RegExpExecArray | null;
  while ((match = nodeEnvRegex.exec(text)) !== null) {
    const varName = match[1];
    if (seen.has(varName)) continue;
    seen.add(varName);
    snippets.push({
      pattern: "env_var",
      raw: match[0],
      summary: `Environment variable: ${varName}`,
    });
  }

  // os.environ["VAR"] or os.environ['VAR'] or os.getenv("VAR")
  const pyEnvRegex = /os\.(?:environ\[|getenv\()["']([A-Z_][A-Z0-9_]*)["']/g;
  while ((match = pyEnvRegex.exec(text)) !== null) {
    const varName = match[1];
    if (seen.has(varName)) continue;
    seen.add(varName);
    snippets.push({
      pattern: "env_var",
      raw: match[0],
      summary: `Environment variable: ${varName}`,
    });
  }

  // .env file lines: KEY=value (at start of line)
  // SECURITY: Only store key name, never the value (values may contain secrets)
  const dotenvRegex = /^([A-Z_][A-Z0-9_]*)=.*$/gm;
  while ((match = dotenvRegex.exec(text)) !== null) {
    const varName = match[1];
    if (seen.has(varName)) continue;
    seen.add(varName);
    snippets.push({
      pattern: "env_var",
      raw: `${varName}=<redacted>`,
      summary: `Environment variable: ${varName}`,
    });
  }

  return snippets;
}

/**
 * Match Docker commands.
 * Looks for: docker run, docker build, docker-compose, Dockerfile instructions.
 */
function matchDockerCommands(text: string): ExtractionSnippet[] {
  const snippets: ExtractionSnippet[] = [];

  // docker run / docker build / docker-compose commands
  const dockerCmdRegex =
    /(?:docker(?:-compose)?)\s+(?:run|build|up|down|exec|pull|push)\b[^\n]*/g;
  let match: RegExpExecArray | null;
  while ((match = dockerCmdRegex.exec(text)) !== null) {
    // SECURITY: Redact -e / --env values which often contain secrets
    // Handles: -e VAR=val, -e "VAR=val with spaces", --env VAR=val, --env="VAR=val"
    let raw = match[0].trim();
    raw = raw.replace(
      /(?:-e|--env)[=\s]+(?:"([A-Za-z_][A-Za-z0-9_]*)=[^"]*"|'([A-Za-z_][A-Za-z0-9_]*)=[^']*'|([A-Za-z_][A-Za-z0-9_]*)=[^\s]*)/g,
      (_m, dq, sq, bare) => `${dq ?? sq ?? bare}=<redacted>`,
    );
    snippets.push({
      pattern: "docker_command",
      raw,
      summary: `Docker command: ${raw.slice(0, 120)}`,
    });
  }

  // Dockerfile instructions (FROM, RUN, COPY, etc.)
  const dockerfileRegex =
    /^(?:FROM|RUN|COPY|ADD|EXPOSE|CMD|ENTRYPOINT|WORKDIR|ENV|ARG|VOLUME)\s+[^\n]+/gm;
  while ((match = dockerfileRegex.exec(text)) !== null) {
    let raw = match[0].trim();
    // SECURITY: Redact values in ENV/ARG instructions (may contain secrets)
    if (/^(?:ENV|ARG)\s/.test(raw)) {
      // Handle KEY=value syntax (including quoted values with spaces)
      raw = raw.replace(/([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|\S*)/g, "$1=<redacted>");
      // Handle legacy space-separated syntax: ENV KEY value
      if (!raw.includes("=")) {
        raw = raw.replace(/^((?:ENV|ARG)\s+[A-Za-z_][A-Za-z0-9_]*)\s+\S.*/,  "$1 <redacted>");
      }
    }
    snippets.push({
      pattern: "docker_command",
      raw,
      summary: `Dockerfile instruction: ${raw.slice(0, 120)}`,
    });
  }

  return snippets;
}

/**
 * Extract structured snippets from tool result entries by pattern-matching
 * known output shapes. Returns classified snippets that can feed into
 * LLM-based extraction for synthesis.
 */
export function extractStructuredSnippets(
  toolResults: ToolResultEntry[]
): ExtractionSnippet[] {
  const snippets: ExtractionSnippet[] = [];

  for (const entry of toolResults) {
    const text = entry.content;

    snippets.push(...matchPythonDicts(text));
    snippets.push(...matchSqlSelects(text));
    snippets.push(...matchAttributeErrors(text));
    snippets.push(...matchKeyErrors(text));
    snippets.push(...matchRoutePatterns(text));
    snippets.push(...matchEnvVars(text));
    snippets.push(...matchDockerCommands(text));
  }

  return snippets;
}
