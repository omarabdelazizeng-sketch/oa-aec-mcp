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
  "get_datums",
  "Read-only. Return every level and grid in the active Revit model plus the Project Base Point, Survey Point " +
  "and true-north angle, all in millimetres. Levels give internal_elevation_mm (relative to the internal origin) " +
  "and elevation_mm (relative to the level type's elevation base). Grids give start_mm/end_mm and is_curved. " +
  "Reports raw facts only — use it to CHECK a model against a spec independently of apply_datums.",
  {},
  async () => {
    const result = await callWebSocket("get_datums");
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "apply_datums",
  "Create or update the project datum, levels and grids in the active Revit model from a spec, in ONE transaction. " +
  "Idempotent: elements are matched by name and re-running the same spec changes nothing. Never deletes elements " +
  "that are not in the spec (they are reported as warnings). Order is fixed: datum, then levels, then grids. " +
  "The Project Base Point is kept at the internal origin; datum sets the shared coordinates of the internal origin. " +
  "Level elevations are relative to the internal origin. All lengths in millimetres. " +
  "Always verify the result with get_datums afterwards.",
  {
    datum: z.object({
      x_mm: z.number().default(0).describe("Shared East/West of the internal origin (mm)"),
      y_mm: z.number().default(0).describe("Shared North/South of the internal origin (mm)"),
      elevation_mm: z.number().describe("Shared elevation of the internal origin / ±0.00 (mm), e.g. 213200"),
      angle_to_true_north_deg: z.number().default(0),
    }).optional(),
    levels: z.array(z.object({
      name: z.string().min(1),
      elevation_mm: z.number().describe("Elevation relative to the internal origin (mm)"),
    })).optional(),
    grids: z.array(z.object({
      name: z.string().min(1),
      start_mm: z.array(z.number()).length(2).describe("[x, y] in mm"),
      end_mm: z.array(z.number()).length(2).describe("[x, y] in mm"),
    })).optional(),
    create_floor_plans: z.boolean().default(true).describe("Create a floor plan for any spec level that has none"),
  },
  async ({ datum, levels, grids, create_floor_plans }) => {
    const params: Record<string, unknown> = { create_floor_plans };
    if (datum !== undefined) params["datum"] = datum;
    if (levels !== undefined) params["levels"] = levels;
    if (grids !== undefined) params["grids"] = grids;
    const result = await callWebSocket("apply_datums", params, 35_000);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

const pt = z.array(z.number()).length(2).describe("[x, y] in mm");

server.tool(
  "ensure_types",
  "Create or update element types in the active Revit model, in ONE transaction (modeling step 4). " +
  "Idempotent: matched by type name, updated only where different, never deleted. " +
  "Columns: duplicate a loaded family type and set its length parameters (e.g. b, h) in mm. " +
  "Floors/walls: duplicate a base type and replace its layers (function, width_mm, material name). " +
  "Walls must be Basic walls.",
  {
    types: z.array(z.object({
      kind: z.enum(["structural_column", "column", "floor", "wall"]),
      name: z.string().min(1),
      family: z.string().optional().describe("Required for columns: loaded family name"),
      base_type: z.string().optional().describe("Type to duplicate when the named type does not exist"),
      params_mm: z.record(z.string(), z.number()).optional().describe("Column type length parameters in mm, e.g. {\"b\":250,\"h\":500}"),
      layers: z.array(z.object({
        function: z.enum(["Structure", "Substrate", "Insulation", "Finish1", "Finish2", "Membrane", "StructuralDeck"]),
        width_mm: z.number().min(0),
        material: z.string().optional(),
      })).optional().describe("Floor/wall layers, exterior/top first"),
    })).min(1),
  },
  async ({ types }) => {
    const result = await callWebSocket("ensure_types", { types }, 35_000);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "apply_columns",
  "Place or update columns in the active Revit model, in ONE transaction (modeling step 6). " +
  "Idempotent: matched by Mark within the category; updates type, position, rotation, levels and offsets in place; " +
  "columns whose Mark is not in the spec are never touched. All lengths in mm. Keep batches to a few hundred. " +
  "Verify afterwards with get_model_elements.",
  {
    columns: z.array(z.object({
      mark: z.string().min(1),
      kind: z.enum(["structural", "architectural"]).default("structural"),
      family: z.string().min(1),
      type: z.string().min(1),
      x_mm: z.number(),
      y_mm: z.number(),
      rotation_deg: z.number().default(0),
      base_level: z.string().min(1),
      base_offset_mm: z.number().default(0),
      top_level: z.string().min(1),
      top_offset_mm: z.number().default(0),
    })).min(1),
  },
  async ({ columns }) => {
    const result = await callWebSocket("apply_columns", { columns }, 35_000);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "apply_floors",
  "Create or update floors/slabs from boundary polygons in the active Revit model, in ONE transaction (modeling step 6). " +
  "Idempotent: matched by Mark; unchanged floors are left alone, changed ones are replaced with the same Mark; " +
  "floors whose Mark is not in the spec are never touched. Straight edges only (send curves as polylines). " +
  "Openings are inner loops (stairs, shafts). All lengths in mm. Verify afterwards with get_model_elements.",
  {
    floors: z.array(z.object({
      mark: z.string().min(1),
      type: z.string().min(1),
      level: z.string().min(1),
      offset_mm: z.number().default(0).describe("Height offset from the level (mm)"),
      structural: z.boolean().default(false),
      boundary: z.array(pt).min(3),
      openings: z.array(z.array(pt).min(3)).optional(),
    })).min(1),
  },
  async ({ floors }) => {
    const result = await callWebSocket("apply_floors", { floors }, 35_000);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "get_model_elements",
  "Read-only. Report structural columns, architectural columns, floors, walls and their types from the active Revit model, " +
  "in mm (positions, levels, offsets, floor sketch loops, type layers, column type length parameters). " +
  "Raw facts only — use it to CHECK the model against a spec independently of the apply_* tools.",
  {
    categories: z.array(z.enum(["structural_columns", "columns", "floors", "walls", "types"])).optional()
      .describe("Default: all"),
  },
  async ({ categories }) => {
    const params: Record<string, unknown> = {};
    if (categories !== undefined) params["categories"] = categories;
    const result = await callWebSocket("get_model_elements", params, 35_000);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
