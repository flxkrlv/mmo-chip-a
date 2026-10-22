import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  AnnotationNet,
  Cell,
  CommentAnnotation,
  DieAnnotations,
  DieSummary,
  FloorplanRegion,
  IOPin,
  RulerMeasurement
} from "shared";
import type { BackendClient } from "../client.js";
import type { McpConfig } from "../config.js";
import { collectTypeBoxes, type Rect } from "../footprint.js";
import {
  ALL_KINDS,
  SUMMARY_KINDS,
  assertSize,
  buildSummary,
  parseKinds,
  pickKinds
} from "../summary.js";
import { InputError, definedOnly, guarded, idOf, json, requireFields } from "../result.js";

interface MutationResult {
  ok: boolean;
  rev: number;
}

const RECT = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number()
});

const WIRE_LAYERS = [
  "poly",
  "metal1",
  "metal2",
  "metal3",
  "metal4",
  "metal5",
  "metal6"
] as const;

export function registerAnnotationTools(
  server: McpServer,
  client: BackendClient,
  config: McpConfig
): string[] {
  const names: string[] = [];
  const diePath = (dieId: string): string => `/api/dies/${encodeURIComponent(dieId)}`;
  const annotationsPath = (dieId: string): string => `${diePath(dieId)}/annotations`;
  const getAnnotations = async (dieId: string): Promise<DieAnnotations> =>
    await client.getJson<DieAnnotations>(annotationsPath(dieId));

  server.registerTool(
    "get_annotations",
    {
      title: "Get annotations",
      description:
        "Read the annotation store of a die project. mode summary (default) returns identity, rev, umPerPx, counts for every collection plus a per-kind index capped at `limit` rows (nets: id/name/nodeCount/edgeCount; cells: id/cellTypeId/x/y and a pixel rect when its type is resolvable; cellTypes: id/name/w/h; and pins, rulers, comments, floorplans, grids, rois, ignores, guides, human annotations). mode full returns whole raw collections and therefore REQUIRES `kinds` (payloads over ~4 MB are rejected with a hint to narrow it). `rev` increments on every write: pass it back when you need to detect concurrent edits. Read-only; writes go through the edit_* tools.",
      inputSchema: {
        dieId: z.string().describe("Project id from list_projects"),
        mode: z.enum(["summary", "full"]).default("summary"),
        kinds: z
          .array(z.string())
          .optional()
          .describe(
            `Collections to return (${ALL_KINDS.join(", ")}). Required for mode:"full"; ` +
              `summary accepts ${SUMMARY_KINDS.join(", ")}`
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .default(500)
          .describe("Max rows per collection in summary mode")
      }
    },
    async ({ dieId, mode, kinds, limit }) =>
      guarded(async () => {
        const annotations = await getAnnotations(dieId);
        if (mode === "full") {
          const wanted = parseKinds(kinds, ALL_KINDS);
          const payload = {
            version: annotations.version,
            rev: annotations.rev,
            umPerPx: annotations.umPerPx ?? null,
            ...pickKinds(annotations, wanted)
          };
          assertSize(payload, `mode:"full" with kinds [${wanted.join(", ")}]`);
          return json(payload);
        }
        const selected = kinds ? parseKinds(kinds, SUMMARY_KINDS) : null;
        const boxes =
          !selected || selected.includes("cells")
            ? await loadTypeBoxes(dieId, annotations)
            : new Map<string, Rect>();
        return json(
          buildSummary(annotations, { ...(kinds ? { kinds } : {}), limit }, boxes)
        );
      })
  );
  names.push("get_annotations");

  server.registerTool(
    "set_scale",
    {
      title: "Set die scale",
      description:
        "Set the die's physical scale: umPerPx (micrometres per source-image pixel). It is what makes ruler lengths come out in µm. Pass the value you derived from a known dimension (a ruler of known physical length divided by its pixel length).",
      inputSchema: {
        dieId: z.string(),
        umPerPx: z.number().positive().describe("Micrometres per source pixel")
      }
    },
    async ({ dieId, umPerPx }) =>
      guarded(async () => {
        const result = await client.putJson<MutationResult>(
          `${diePath(dieId)}/config`,
          { umPerPx }
        );
        return json({ ...result, action: "set_scale", umPerPx });
      })
  );
  names.push("set_scale");

  server.registerTool(
    "edit_nets",
    {
      title: "Edit nets",
      description:
        "Create, reshape and delete wire nets (nodes = points in die pixels, edges = connections between node ids). Writes are per-entity PUT/DELETE on /nets/...; each returns the new annotation `rev`. upsert_net creates or replaces a net — omitting nodes/edges keeps an existing net's topology and only the provided fields change; pass nodes: [] / edges: [] to clear them. upsert_edge requires both endpoints to be existing nodes of that net. Deleting a node cascades: edges referencing it are dropped. Always read get_annotations first to learn ids and avoid clobbering concurrent edits.",
      inputSchema: {
        dieId: z.string(),
        action: z.enum([
          "upsert_net",
          "delete_net",
          "upsert_node",
          "delete_node",
          "upsert_edge",
          "delete_edge"
        ]),
        netId: z.string().optional().describe("Net id; generated when upserting a new net"),
        name: z.string().optional().describe("Net name (required for a new net)"),
        nodeId: z.string().optional().describe("Node id; generated when omitted"),
        edgeId: z.string().optional().describe("Edge id; generated when omitted"),
        x: z.number().optional().describe("Node x, die pixels"),
        y: z.number().optional().describe("Node y, die pixels"),
        from: z.string().optional().describe("Source node id (upsert_edge)"),
        to: z.string().optional().describe("Target node id (upsert_edge)"),
        layer: z.enum(WIRE_LAYERS).optional(),
        nodes: z
          .array(z.object({ id: z.string().optional(), x: z.number(), y: z.number() }))
          .optional()
          .describe("Whole node list for upsert_net"),
        edges: z
          .array(
            z.object({
              id: z.string().optional(),
              from: z.string(),
              to: z.string(),
              layer: z.enum(WIRE_LAYERS).optional()
            })
          )
          .optional()
          .describe("Whole edge list for upsert_net")
      }
    },
    async (args) =>
      guarded(async () => {
        const { action, dieId, netId, name, nodeId, edgeId, x, y, from, to, layer, nodes, edges } =
          args;
        const netsPath = `${diePath(dieId)}/nets`;
        if (action === "upsert_net") {
          const annotations = await getAnnotations(dieId);
          const existing = netId ? annotations.nets.find((n) => n.id === netId) : undefined;
          const id = netId ?? idOf("net");
          const netName = name ?? existing?.name;
          if (!netName) {
            throw new InputError("upsert_net requires name for a net that does not exist yet");
          }
          const net: AnnotationNet = {
            id,
            name: netName,
            nodes: (nodes ?? existing?.nodes ?? []).map((node) => ({
              id: node.id ?? idOf("node"),
              x: node.x,
              y: node.y
            })),
            edges: (edges ?? existing?.edges ?? []).map((edge) => ({
              id: edge.id ?? idOf("edge"),
              from: edge.from,
              to: edge.to,
              ...(edge.layer ? { layer: edge.layer } : {})
            }))
          };
          const result = await client.putJson<MutationResult>(
            `${netsPath}/${encodeURIComponent(id)}`,
            net
          );
          return json({
            ...result,
            action,
            netId: id,
            nodeCount: net.nodes.length,
            edgeCount: net.edges.length
          });
        }

        if (action === "delete_net") {
          requireFields(action, { netId }, ["netId"]);
          const result = await client.deleteJson<MutationResult>(
            `${netsPath}/${encodeURIComponent(netId!)}`
          );
          return json({ ...result, action, netId });
        }

        if (action === "upsert_node") {
          requireFields(action, { netId, x, y }, ["netId", "x", "y"]);
          const id = nodeId ?? idOf("node");
          const node = { id, x: x!, y: y! };
          const result = await client.putJson<MutationResult>(
            `${netsPath}/${encodeURIComponent(netId!)}/nodes/${encodeURIComponent(id)}`,
            node
          );
          return json({ ...result, action, netId, nodeId: id });
        }

        if (action === "delete_node") {
          requireFields(action, { netId, nodeId }, ["netId", "nodeId"]);
          const result = await client.deleteJson<MutationResult>(
            `${netsPath}/${encodeURIComponent(netId!)}/nodes/${encodeURIComponent(nodeId!)}`
          );
          return json({
            ...result,
            action,
            netId,
            nodeId,
            note: "edges referencing this node were dropped"
          });
        }

        if (action === "upsert_edge") {
          requireFields(action, { netId, edgeId, from, to }, ["netId", "edgeId", "from", "to"]);
          const annotations = await getAnnotations(dieId);
          const net = annotations.nets.find((n) => n.id === netId);
          if (!net) throw new InputError(`Net "${netId}" not found on this die`);
          const nodeIds = new Set(net.nodes.map((n) => n.id));
          const unknown = [from!, to!].filter((endpoint) => !nodeIds.has(endpoint));
          if (unknown.length > 0) {
            const sample = [...nodeIds].slice(0, 20).join(", ");
            throw new InputError(
              `Edge endpoint(s) [${unknown.join(", ")}] are not nodes of net "${netId}". ` +
                `Existing nodes: ${nodeIds.size > 0 ? sample + (nodeIds.size > 20 ? ", ..." : "") : "(none)"}`
            );
          }
          const edge = {
            id: edgeId!,
            from: from!,
            to: to!,
            ...(layer ? { layer } : {})
          };
          const result = await client.putJson<MutationResult>(
            `${netsPath}/${encodeURIComponent(netId!)}/edges/${encodeURIComponent(edgeId!)}`,
            edge
          );
          return json({ ...result, action, netId, edgeId });
        }

        requireFields(action, { netId, edgeId }, ["netId", "edgeId"]);
        const result = await client.deleteJson<MutationResult>(
          `${netsPath}/${encodeURIComponent(netId!)}/edges/${encodeURIComponent(edgeId!)}`
        );
        return json({ ...result, action, netId, edgeId });
      })
  );
  names.push("edit_nets");

  server.registerTool(
    "edit_cells",
    {
      title: "Edit cells",
      description:
        "Place, move, re-orient and remove cell instances. Upsert merges into the stored instance, so passing only x/y moves a cell without touching its type or orientation; a brand-new cell additionally needs cellTypeId, x and y. Coordinates are die pixels (cell origin = top-left of its footprint), rotation is 0/90/180/270 clockwise, flips are booleans, bounds is a per-instance footprint override relative to the origin. Cell types are never created here — extract them in the app or reuse an existing id; a type owned by another project of the same cell library needs its cellTypeDieId.",
      inputSchema: {
        dieId: z.string(),
        action: z.enum(["upsert", "delete"]),
        cellId: z.string().optional().describe("Cell instance id; generated when creating"),
        cellTypeId: z.string().optional().describe("Required when creating a cell"),
        cellTypeDieId: z.string().optional().describe("Owning die for a shared library type"),
        x: z.number().optional(),
        y: z.number().optional(),
        rotation: z.number().optional().describe("0, 90, 180 or 270 (clockwise)"),
        flippedH: z.boolean().optional(),
        flippedV: z.boolean().optional(),
        scale: z.number().positive().optional().describe("Instance pixels per library unit"),
        bounds: RECT.optional().describe("Footprint override in die pixels"),
        merged: z.boolean().optional(),
        mlDetected: z.boolean().optional(),
        mlConfidence: z.number().optional()
      }
    },
    async (args) =>
      guarded(async () => {
        const { action, dieId, cellId } = args;
        const cellsPath = `${diePath(dieId)}/cells`;
        if (action === "delete") {
          requireFields(action, { cellId }, ["cellId"]);
          const result = await client.deleteJson<MutationResult>(
            `${cellsPath}/${encodeURIComponent(cellId!)}`
          );
          return json({ ...result, action, cellId });
        }

        const annotations = await getAnnotations(dieId);
        const existing = cellId ? annotations.cells.find((c) => c.id === cellId) : undefined;
        const patch = definedOnly({
          cellTypeId: args.cellTypeId,
          cellTypeDieId: args.cellTypeDieId,
          x: args.x,
          y: args.y,
          rotation: args.rotation,
          flippedH: args.flippedH,
          flippedV: args.flippedV,
          scale: args.scale,
          bounds: args.bounds,
          merged: args.merged,
          mlDetected: args.mlDetected,
          mlConfidence: args.mlConfidence
        });
        let cell: Cell;
        if (existing) {
          cell = { ...existing, ...patch } as Cell;
        } else {
          if (patch.cellTypeId === undefined) {
            throw new InputError("cellTypeId is required to create a cell");
          }
          if (patch.x === undefined || patch.y === undefined) {
            throw new InputError("x and y are required to create a cell");
          }
          cell = { id: cellId ?? idOf("cell"), ...patch } as Cell;
          const ownedHere = annotations.cellTypes.some((t) => t.id === cell.cellTypeId);
          if (!ownedHere && !cell.cellTypeDieId) {
            throw new InputError(
              `Cell type "${cell.cellTypeId}" is not defined on this die. ` +
                `Pass cellTypeDieId (the owning die id) for a shared library type, or create the type first.`
            );
          }
        }
        const rotation = cell.rotation ?? 0;
        if (![0, 90, 180, 270].includes(rotation)) {
          throw new InputError(`rotation must be 0, 90, 180 or 270 (got ${rotation})`);
        }
        const result = await client.putJson<MutationResult>(
          `${cellsPath}/${encodeURIComponent(cell.id)}`,
          cell
        );
        return json({ ...result, action, cellId: cell.id, cellTypeId: cell.cellTypeId });
      })
  );
  names.push("edit_cells");

  server.registerTool(
    "edit_pins",
    {
      title: "Edit I/O pins",
      description:
        "Add, move and delete I/O pad pins (a pin is x/y in die pixels, a pin number and a name). Upsert merges into the stored pin, so partial updates are safe; a new pin needs x, y, pin and name.",
      inputSchema: {
        dieId: z.string(),
        action: z.enum(["upsert", "delete"]),
        pinId: z.string().optional().describe("Pin id; generated when creating"),
        x: z.number().optional(),
        y: z.number().optional(),
        pin: z.number().int().optional().describe("Pad number"),
        name: z.string().optional().describe("Pin name, e.g. VDD")
      }
    },
    async (args) =>
      guarded(async () => {
        const { action, dieId, pinId } = args;
        const pinsPath = `${diePath(dieId)}/pins`;
        if (action === "delete") {
          requireFields(action, { pinId }, ["pinId"]);
          const result = await client.deleteJson<MutationResult>(
            `${pinsPath}/${encodeURIComponent(pinId!)}`
          );
          return json({ ...result, action, pinId });
        }

        const annotations = await getAnnotations(dieId);
        const existing = pinId ? (annotations.pins ?? []).find((p) => p.id === pinId) : undefined;
        const patch = definedOnly({ x: args.x, y: args.y, pin: args.pin, name: args.name });
        let pin: IOPin;
        if (existing) {
          pin = { ...existing, ...patch } as IOPin;
        } else {
          if (
            patch.x === undefined ||
            patch.y === undefined ||
            patch.pin === undefined ||
            patch.name === undefined
          ) {
            throw new InputError("creating a pin requires: x, y, pin, name");
          }
          pin = { id: pinId ?? idOf("pin"), ...patch } as IOPin;
        }
        const result = await client.putJson<MutationResult>(
          `${pinsPath}/${encodeURIComponent(pin.id)}`,
          pin
        );
        return json({ ...result, action, pinId: pin.id, name: pin.name });
      })
  );
  names.push("edit_pins");

  server.registerTool(
    "edit_rulers",
    {
      title: "Edit rulers",
      description:
        "Add, move and delete measurement rulers. lengthPx/lengthUm are cached on the ruler, so this tool recomputes them from the endpoints and the die's umPerPx (0 µm until set_scale has been called). Endpoints are in die pixels; pass a name to label it.",
      inputSchema: {
        dieId: z.string(),
        action: z.enum(["upsert", "delete"]),
        rulerId: z.string().optional().describe("Ruler id; generated when creating"),
        x1: z.number().optional().describe("Start x, die pixels"),
        y1: z.number().optional().describe("Start y, die pixels"),
        x2: z.number().optional().describe("End x, die pixels"),
        y2: z.number().optional().describe("End y, die pixels"),
        name: z.string().optional()
      }
    },
    async (args) =>
      guarded(async () => {
        const { action, dieId, rulerId } = args;
        const rulersPath = `${diePath(dieId)}/rulers`;
        if (action === "delete") {
          requireFields(action, { rulerId }, ["rulerId"]);
          const result = await client.deleteJson<MutationResult>(
            `${rulersPath}/${encodeURIComponent(rulerId!)}`
          );
          return json({ ...result, action, rulerId });
        }

        const annotations = await getAnnotations(dieId);
        const existing = rulerId
          ? (annotations.rulers ?? []).find((r) => r.id === rulerId)
          : undefined;
        const patch = definedOnly({ x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2, name: args.name });
        let ruler: RulerMeasurement;
        if (existing) {
          ruler = { ...existing, ...patch } as RulerMeasurement;
        } else {
          if (
            patch.x1 === undefined ||
            patch.y1 === undefined ||
            patch.x2 === undefined ||
            patch.y2 === undefined
          ) {
            throw new InputError("creating a ruler requires: x1, y1, x2, y2");
          }
          ruler = { id: rulerId ?? idOf("ruler"), ...patch } as RulerMeasurement;
        }
        const touchedEndpoints =
          args.x1 !== undefined || args.y1 !== undefined || args.x2 !== undefined || args.y2 !== undefined;
        if (touchedEndpoints || ruler.lengthPx === undefined || ruler.lengthUm === undefined) {
          const lengthPx = Math.hypot(ruler.x2 - ruler.x1, ruler.y2 - ruler.y1);
          ruler.lengthPx = lengthPx;
          ruler.lengthUm = lengthPx * (annotations.umPerPx ?? 0);
        }
        const result = await client.putJson<MutationResult>(
          `${rulersPath}/${encodeURIComponent(ruler.id)}`,
          ruler
        );
        return json({ ...result, action, rulerId: ruler.id, ...pickLength(ruler) });
      })
  );
  names.push("edit_rulers");

  server.registerTool(
    "edit_comments",
    {
      title: "Edit comments",
      description:
        "Pin comments to the die image, reply to them, or delete them. A comment carries authorId/authorName, stamped as this MCP agent (MMO_AGENT_NAME); replies append to the comment's thread through a read-modify-write. Positions are die pixels. Deleting a comment removes its whole thread.",
      inputSchema: {
        dieId: z.string(),
        action: z.enum(["add", "reply", "delete"]),
        commentId: z.string().optional().describe("Comment id; generated on add, required otherwise"),
        x: z.number().optional().describe("Comment x, die pixels (add only)"),
        y: z.number().optional().describe("Comment y, die pixels (add only)"),
        text: z.string().optional().describe("Comment or reply body (add/reply)")
      }
    },
    async (args) =>
      guarded(async () => {
        const { action, dieId, commentId, x, y, text } = args;
        const commentsPath = `${diePath(dieId)}/comments`;
        const authorName = config.agentName;
        const authorId = "mcp";
        const now = new Date().toISOString();

        if (action === "delete") {
          requireFields(action, { commentId }, ["commentId"]);
          const result = await client.deleteJson<MutationResult>(
            `${commentsPath}/${encodeURIComponent(commentId!)}`
          );
          return json({ ...result, action, commentId });
        }

        requireFields(action, { text }, ["text"]);
        if (action === "add") {
          requireFields(action, { x, y }, ["x", "y"]);
          const comment: CommentAnnotation = {
            id: commentId ?? idOf("cmt"),
            x: x!,
            y: y!,
            text: text!,
            authorId,
            authorName,
            createdAt: now,
            replies: []
          };
          const result = await client.putJson<MutationResult>(
            `${commentsPath}/${encodeURIComponent(comment.id)}`,
            comment
          );
          return json({ ...result, action, commentId: comment.id });
        }

        const annotations = await getAnnotations(dieId);
        const comment = (annotations.comments ?? []).find((c) => c.id === commentId);
        if (!comment) {
          throw new InputError(
            `Comment "${commentId}" not found. Reply needs an existing comment; use action add for a new one.`
          );
        }
        comment.replies = [
          ...(comment.replies ?? []),
          { id: idOf("reply"), text: text!, authorId, authorName, createdAt: now }
        ];
        const result = await client.putJson<MutationResult>(
          `${commentsPath}/${encodeURIComponent(comment.id)}`,
          comment
        );
        return json({ ...result, action, commentId: comment.id, replies: comment.replies.length });
      })
  );
  names.push("edit_comments");

  server.registerTool(
    "edit_floorplans",
    {
      title: "Edit floorplan regions",
      description:
        "Draw, reshape and delete named functional-block outlines (VCC_UVLO, bandgap, ...). kind rect takes exactly 2 corner points, polygon takes 3+. On create, color defaults to the app's default blue and createdBy/createdByName are stamped as this MCP agent; on update only the fields you pass change.",
      inputSchema: {
        dieId: z.string(),
        action: z.enum(["upsert", "delete"]),
        regionId: z.string().optional().describe("Region id; generated when creating"),
        name: z.string().optional().describe("Required when creating a region"),
        kind: z.enum(["rect", "polygon"]).optional(),
        geometry: z
          .array(z.object({ x: z.number(), y: z.number() }))
          .optional()
          .describe("2 points for rect, 3+ for polygon, in die pixels"),
        color: z.string().optional().describe("CSS color, e.g. #4dabf7")
      }
    },
    async (args) =>
      guarded(async () => {
        const { action, dieId, regionId } = args;
        const regionsPath = `${diePath(dieId)}/floorplan`;
        if (action === "delete") {
          requireFields(action, { regionId }, ["regionId"]);
          const result = await client.deleteJson<MutationResult>(
            `${regionsPath}/${encodeURIComponent(regionId!)}`
          );
          return json({ ...result, action, regionId });
        }

        const annotations = await getAnnotations(dieId);
        const existing = regionId
          ? (annotations.floorplanRegions ?? []).find((r) => r.id === regionId)
          : undefined;
        const patch = definedOnly({
          name: args.name,
          kind: args.kind,
          geometry: args.geometry,
          color: args.color
        });
        let region: FloorplanRegion;
        if (existing) {
          region = { ...existing, ...patch } as FloorplanRegion;
        } else {
          if (patch.name === undefined) {
            throw new InputError("creating a region requires: name, kind, geometry");
          }
          if (patch.kind === undefined || patch.geometry === undefined) {
            throw new InputError("creating a region requires: kind, geometry");
          }
          region = {
            id: regionId ?? idOf("zone"),
            ...patch,
            color: patch.color ?? "#4dabf7",
            createdBy: "mcp",
            createdByName: config.agentName,
            createdAt: new Date().toISOString(),
            reservedBy: null,
            reservedByName: null,
            reservedAt: null
          } as FloorplanRegion;
        }
        const points = region.geometry.length;
        if (region.kind === "rect" && points !== 2) {
          throw new InputError(`rect regions need exactly 2 points (got ${points})`);
        }
        if (region.kind === "polygon" && points < 3) {
          throw new InputError(`polygon regions need at least 3 points (got ${points})`);
        }
        const result = await client.putJson<MutationResult>(
          `${regionsPath}/${encodeURIComponent(region.id)}`,
          region
        );
        return json({ ...result, action, regionId: region.id, name: region.name, points });
      })
  );
  names.push("edit_floorplans");

  async function loadTypeBoxes(
    dieId: string,
    annotations: DieAnnotations
  ): Promise<Map<string, Rect>> {
    const owned = new Set(annotations.cellTypes.map((t) => t.id));
    const usesForeign = annotations.cells.some(
      (cell) => cell.cellTypeDieId && cell.cellTypeDieId !== dieId && !owned.has(cell.cellTypeId)
    );
    const die: Pick<DieSummary, "id" | "cellScale"> = usesForeign
      ? await client.getJson<DieSummary>(diePath(dieId))
      : { id: dieId };
    return await collectTypeBoxes(client, die, annotations);
  }

  return names;
}

function pickLength(ruler: RulerMeasurement): { lengthPx: number; lengthUm: number } {
  return { lengthPx: ruler.lengthPx, lengthUm: ruler.lengthUm };
}
