import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";

const WS_URL = "ws://localhost:8765";
const TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_ATTEMPTS = 5;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class JsonRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonRpcError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pingOnce(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const requestId = uuidv4();
    const ws = new WebSocket(WS_URL);

    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("WebSocket ping timed out after 10s"));
    }, TIMEOUT_MS);

    ws.once("open", () => {
      const request = JSON.stringify({
        jsonrpc: "2.0",
        method: "ping",
        params: {},
        id: requestId,
      });
      ws.send(request);
    });

    ws.once("message", (data) => {
      clearTimeout(timer);
      ws.close();
      const raw = data.toString();
      let response: JsonRpcResponse;
      try {
        response = JSON.parse(raw) as JsonRpcResponse;
      } catch {
        reject(new Error(raw));
        return;
      }
      if (response.error !== undefined) {
        reject(new JsonRpcError(response.error.message));
      } else if ("result" in response) {
        resolve(response.result);
      } else {
        reject(new Error(raw));
      }
    });

    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function pingWithRetry(): Promise<unknown> {
  let backoff = 1_000;
  let lastError: Error = new Error("Unknown error");

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await pingOnce();
    } catch (err) {
      if (err instanceof JsonRpcError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_ATTEMPTS) {
        await sleep(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }

  throw lastError;
}

const server = new McpServer({
  name: "oa-aec-mcp",
  version: "1.0.0",
});

server.tool(
  "ping",
  "Send a ping to the Revit plugin and return pong",
  {},
  async () => {
    const result = await pingWithRetry();
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
