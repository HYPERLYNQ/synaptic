import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, getEmbedder } from "./server.js";

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);

// Pre-warm embedder in background (don't block tool registration)
getEmbedder().warmup().catch(() => {});
