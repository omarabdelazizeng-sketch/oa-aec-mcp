import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import WebSocket from "ws";

const WS_URL = "ws://localhost:8765";

function pingWebSocket(): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);

    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error("WebSocket ping timed out after 10s"));
    }, 10_000);

    ws.once("open", () => {
      ws.send("ping");
    });

    ws.once("message", (data) => {
      clearTimeout(timeout);
      ws.close();
      resolve(data.toString());
    });

    ws.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

const server = new McpServer({
  name: "oa-aec-mcp",
  version: "1.0.0",
});

server.tool("ping", "Pings the WebSocket server at ws://localhost:8765 and returns its response", {}, async () => {
  const response = await pingWebSocket();
  return {
    content: [{ type: "text", text: response }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
