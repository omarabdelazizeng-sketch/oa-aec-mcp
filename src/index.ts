import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import WebSocket from "ws";
import { z } from "zod";

const WS_URL = "ws://localhost:8765";

// -------------------------------------------------------------------------
// Shared WebSocket JSON-RPC helper
// -------------------------------------------------------------------------

function callWebSocket(
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);

    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error(`WebSocket call '${method}' timed out after 10s`));
    }, 10_000);

    ws.once("open", () => {
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method,
          params,
          id: Math.random().toString(36).slice(2),
        })
      );
    });

    ws.once("message", (data) => {
      clearTimeout(timeout);
      ws.close();
      try {
        const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
        if (parsed["result"] !== undefined) {
          resolve(parsed["result"]);
        } else if (parsed["error"]) {
          reject(
            new Error(
              (parsed["error"] as { message: string }).message
            )
          );
        } else {
          reject(new Error("Unexpected response: " + data.toString()));
        }
      } catch {
        reject(new Error("Non-JSON response: " + data.toString()));
      }
    });

    ws.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// -------------------------------------------------------------------------
// MCP server
// -------------------------------------------------------------------------

const server = new McpServer({
  name: "oa-aec-mcp",
  version: "1.0.0",
});

server.tool(
  "ping",
  "Pings the WebSocket server at ws://localhost:8765 and returns its response",
  {},
  async () => {
    const result = await callWebSocket("ping");
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  }
);

server.tool(
  "summarize_model_health",
  "Summarize the health of the active Revit model including warnings, unplaced rooms, unused families, and view count",
  {},
  async () => {
    const result = await callWebSocket("summarize_model_health");
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "list_unplaced_rooms",
  "List all unplaced rooms in the active Revit model (rooms with no bounding elements), returning id, name, department, and level_name for each. Optionally filter by level name.",
  {
    level: z.string().optional().describe(
      "Filter by level name (case-insensitive exact match, e.g. \"Level 1\"). Omit to return all levels."
    ),
  },
  async ({ level }) => {
    const params: Record<string, unknown> = {};
    if (level !== undefined) params["level"] = level;
    const result = await callWebSocket("list_unplaced_rooms", params);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "find_warnings_by_category",
  "Return Revit model warnings grouped by description, ordered by count. Optionally filter by the Revit category of the failing elements (e.g. \"Walls\", \"Rooms\", \"Floors\").",
  {
    category: z.string().optional().describe(
      "Revit category name to filter by (case-insensitive exact match). Omit or pass \"all\" to return warnings across all categories."
    ),
  },
  async ({ category }) => {
    const params: Record<string, unknown> = {};
    if (category !== undefined) params["category"] = category;
    const result = await callWebSocket("find_warnings_by_category", params);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
