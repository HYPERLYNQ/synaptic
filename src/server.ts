import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ContextIndex } from "./storage/sqlite.js";
import { Embedder } from "./storage/embedder.js";
import { ensureDirs } from "./storage/paths.js";
import { contextSave, contextSaveSchema } from "./tools/context-save.js";
import { contextSearch, contextSearchSchema } from "./tools/context-search.js";
import { contextList, contextListSchema } from "./tools/context-list.js";
import { contextStatus } from "./tools/context-status.js";
import { contextArchive, contextArchiveSchema } from "./tools/context-archive.js";
import { contextGitIndex, contextGitIndexSchema } from "./tools/context-git-index.js";
import { contextResolvePattern, contextResolvePatternSchema } from "./tools/context-resolve-pattern.js";

export function createServer(): McpServer {
  ensureDirs();
  const index = new ContextIndex();
  const embedder = new Embedder();

  const server = new McpServer({
    name: "synaptic",
    version: "0.3.0",
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
    "Show storage stats: total entries, date range, database size",
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

  return server;
}
