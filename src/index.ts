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
  params: Record<string, unknown> = {},
  timeoutMs = 10_000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);

    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error(`WebSocket call '${method}' timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

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

server.tool(
  "audit_naming_conventions",
  "Audit element names in the active Revit model against a regex pattern and return a grouped violations report. " +
  "IMPORTANT: pattern must be a regex — if the user describes a naming convention in natural language, " +
  "convert it to a regex before calling this tool. " +
  "Supported categories: Views, Sheets, Rooms, Levels, Walls, Doors, Windows, Families. " +
  "Default categories (when omitted): Views, Sheets, Rooms, Levels.",
  {
    pattern: z.string().describe(
      "Regular expression to test element names against. Names that do NOT match are reported as violations."
    ),
    categories: z.array(z.string()).optional().describe(
      "Categories to audit. Defaults to [\"Views\", \"Sheets\", \"Rooms\", \"Levels\"] when omitted. " +
      "Supported: Views, Sheets, Rooms, Levels, Walls, Doors, Windows, Families. Unknown names are returned in unknown_categories."
    ),
    max_violations: z.number().int().optional().describe(
      "Maximum violations to return per category (default 50, max 200). The true violation_count is always returned; truncated: true signals the list was capped."
    ),
  },
  async ({ pattern, categories, max_violations }) => {
    const params: Record<string, unknown> = { pattern };
    if (categories !== undefined) params["categories"] = categories;
    if (max_violations !== undefined) params["max_violations"] = max_violations;
    const result = await callWebSocket("audit_naming_conventions", params);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "get_schedule_data",
  "READ-ONLY. Return the contents of a Revit schedule exactly as displayed (Revit's own filters, sorting and formatting). " +
  "Uses the active view when schedule_name is omitted (the active view must then be a schedule). " +
  "Optionally keep only rows whose filter_column cell contains filter_contains (case-insensitive). " +
  "Returns columns (visible headings), rows (string[][]), is_itemized, matched_rows and truncated.",
  {
    schedule_name: z.string().optional().describe(
      "Schedule view name (case-insensitive exact match). Omit to use the active view."
    ),
    filter_column: z.string().optional().describe(
      "Visible column heading to filter on (case-insensitive), e.g. \"LEVEL\". Must be used with filter_contains."
    ),
    filter_contains: z.string().optional().describe(
      "Keep only rows whose filter_column cell contains this text (case-insensitive), e.g. \"LEVEL 05\"."
    ),
    max_rows: z.number().int().optional().describe(
      "Maximum rows to return (default 5000, max 20000). matched_rows always reports the true count."
    ),
  },
  async ({ schedule_name, filter_column, filter_contains, max_rows }) => {
    const params: Record<string, unknown> = {};
    if (schedule_name !== undefined) params["schedule_name"] = schedule_name;
    if (filter_column !== undefined) params["filter_column"] = filter_column;
    if (filter_contains !== undefined) params["filter_contains"] = filter_contains;
    if (max_rows !== undefined) params["max_rows"] = max_rows;
    // Large schedules take longer to read; match the plugin's 30s ExternalEvent timeout.
    const result = await callWebSocket("get_schedule_data", params, 30_000);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
