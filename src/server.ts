import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ContextIndex } from "./storage/sqlite.js";
import { Embedder } from "./storage/embedder.js";
import { ensureDirs } from "./storage/paths.js";
import { detectProject } from "./storage/project.js";
import { contextSave, contextSaveSchema } from "./tools/context-save.js";
import { contextSearch, contextSearchSchema } from "./tools/context-search.js";
import { contextList, contextListSchema } from "./tools/context-list.js";
import { contextStatus } from "./tools/context-status.js";
import { contextArchive, contextArchiveSchema } from "./tools/context-archive.js";
import { contextGitIndex, contextGitIndexSchema } from "./tools/context-git-index.js";
import { contextResolvePattern, contextResolvePatternSchema } from "./tools/context-resolve-pattern.js";
import { contextSaveRule, contextSaveRuleSchema } from "./tools/context-save-rule.js";
import { contextDeleteRule, contextDeleteRuleSchema } from "./tools/context-delete-rule.js";
import { contextListRules } from "./tools/context-list-rules.js";
import { contextSession, contextSessionSchema } from "./tools/context-session.js";
import { contextCochanges, contextCochangesSchema } from "./tools/context-cochanges.js";

let _embedder: Embedder;
let _currentProject: string | null = null;

export function getEmbedder(): Embedder {
  return _embedder;
}

export function getCurrentProject(): string | null {
  return _currentProject;
}

export { getSessionId } from "./storage/session.js";

export function createServer(): McpServer {
  ensureDirs();
  _currentProject = detectProject();
  const index = new ContextIndex();
  _embedder = new Embedder();
  const embedder = _embedder;

  const server = new McpServer({
    name: "synaptic",
    version: "0.5.0-alpha.1",
  });

  server.tool(
    "context_save",
    "Save a context entry (decision, progress, issue, etc.) to persistent local storage",
    contextSaveSchema,
    async (args) => {
      const result = await contextSave(args, index, embedder);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "context_search",
    "Search saved context entries using hybrid semantic + keyword search",
    contextSearchSchema,
    async (args) => {
      const result = await contextSearch(args, index, embedder);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "context_list",
    "List context entries by date range, optionally filtered by type",
    contextListSchema,
    async (args) => {
      const result = contextList(args, index);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "context_status",
    "Show storage stats: total entries, date range, database size, tier distribution, active patterns",
    {},
    async () => {
      const result = contextStatus(index);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "context_archive",
    "Bulk-archive entries by ID list. Archived entries are excluded from search/list by default.",
    contextArchiveSchema,
    async (args) => {
      const result = contextArchive(args, index);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "context_git_index",
    "Index git commits as searchable context entries. Deduplicates by SHA.",
    contextGitIndexSchema,
    async (args) => {
      const result = await contextGitIndex(args, index, embedder);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "context_resolve_pattern",
    "Mark a recurring issue pattern as resolved. Stops surfacing in search and session-start.",
    contextResolvePatternSchema,
    async (args) => {
      const result = contextResolvePattern(args, index);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "context_save_rule",
    "Save or update a persistent rule by label. Rules are injected every session and always enforced. If a rule with this label exists, it is overwritten.",
    contextSaveRuleSchema,
    async (args) => {
      const result = contextSaveRule(args, index);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "context_delete_rule",
    "Delete a persistent rule by its label.",
    contextDeleteRuleSchema,
    async (args) => {
      const result = contextDeleteRule(args, index);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "context_list_rules",
    "List all active rules with their labels and content.",
    {},
    async () => {
      const result = contextListRules(index);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "context_session",
    "List all entries from the current or specified session. Use for agent context sharing.",
    contextSessionSchema,
    async (args) => {
      const result = contextSession(args, index);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "context_cochanges",
    "Get files that frequently co-change with a given file, based on git history.",
    contextCochangesSchema,
    async (args) => {
      const result = contextCochanges(args, index);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  return server;
}
