import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, getEmbedder, startBackgroundServices } from "./server.js";

try {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Start background services AFTER MCP handshake completes
  startBackgroundServices();

  // Pre-warm embedder in background (don't block tool calls)
  getEmbedder().warmup().catch(() => {});
} catch (err) {
  process.stderr.write(`[synaptic] Fatal startup error: ${err}\n`);
  process.exit(1);
}
