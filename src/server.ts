import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ContextIndex } from "./storage/sqlite.js";
import { ensureDirs } from "./storage/paths.js";
import { contextSave, contextSaveSchema } from "./tools/context-save.js";
import { contextSearch, contextSearchSchema } from "./tools/context-search.js";
import { contextList, contextListSchema } from "./tools/context-list.js";
import { contextStatus } from "./tools/context-status.js";

export function createServer(): McpServer {
  ensureDirs();
  const index = new ContextIndex();

  const server = new McpServer({
    name: "synaptic",
    version: "0.1.0",
  });

  server.tool(
    "context_save",
    "Save a context entry (decision, progress, issue, etc.) to persistent local storage",
    contextSaveSchema,
    async (args) => {
      const result = contextSave(args, index);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "context_search",
    "Search saved context entries using BM25 keyword search",
    contextSearchSchema,
    async (args) => {
      const result = contextSearch(args, index);
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

  return server;
}
