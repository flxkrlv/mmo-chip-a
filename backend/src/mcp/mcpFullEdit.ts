import type { AnnotationNet, DieAnnotations, McpCollection, McpValueSection } from "shared";
import { describe, isValueSection, MCP_VALUE_SECTIONS, McpEditError, type McpOwned, type McpTarget } from "./mcpState.js";
import { str, ToolInputError, write, type ToolDef } from "./mcpToolKit.js";

/**
 * Full edits: one batch tool that can create, replace or delete any annotation
 * (human-made too), gated by the die's "Full edits" toggle. A batch is applied
 * in order to a working copy — so later operations see earlier ones (e.g. a
 * new cell type, then cells of it) — and recorded as ONE MCP undo step.
 */

const LIST_SECTIONS: McpCollection[] = [
  "nets",
  "cellTypes",
  "cells",
  "grids",
  "pins",
  "annotations",
  "rois",
  "ignores",
  "guides",
  "rulers",
  "comments",
  "floorplanRegions"
];

/** Sections whose new items count as MCP-created for the ownership rules. */
const OWNED_SECTIONS: Partial<Record<McpCollection, keyof McpOwned>> = {
  comments: "comments",
  floorplanRegions: "floorplanRegions",
  rulers: "rulers",
  nets: "nets",
  annotations: "annotations"
};

type Op =
  | { op: "upsert"; section: McpCollection; item: Record<string, unknown> & { id: string } }
  | { op: "delete"; section: McpCollection; id: string }
  | { op: "set"; section: McpValueSection; value: unknown };

function parseOp(raw: unknown, i: number): Op {
  const o = raw as Record<string, unknown>;
  if (!o || typeof o !== "object") throw new ToolInputError(`operations[${i}] must be an object`);
  const section = o.section;
  if (o.op === "set") {
    if (typeof section !== "string" || !isValueSection(section)) {
      throw new ToolInputError(`operations[${i}]: "set" works on ${MCP_VALUE_SECTIONS.join(", ")}`);
    }
    if (!("value" in o)) throw new ToolInputError(`operations[${i}]: "set" needs a value (null removes it)`);
    return { op: "set", section, value: o.value };
  }
  if (typeof section !== "string" || !(LIST_SECTIONS as string[]).includes(section)) {
    throw new ToolInputError(`operations[${i}]: "section" must be one of ${LIST_SECTIONS.join(", ")}`);
  }
  if (o.op === "upsert") {
    const item = o.item as Record<string, unknown> | undefined;
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.id !== "string" || !item.id) {
      throw new ToolInputError(`operations[${i}]: "upsert" needs an item object with a string id`);
    }
    return { op: "upsert", section: section as McpCollection, item: item as Record<string, unknown> & { id: string } };
  }
  if (o.op === "delete") {
    return { op: "delete", section: section as McpCollection, id: str(o, "id") };
  }
  throw new ToolInputError(`operations[${i}].op must be "upsert", "delete" or "set"`);
}

/** Light structural checks: what would break the app if wrong. */
function validate(working: DieAnnotations, op: Op, i: number): void {
  const at = `operations[${i}]`;
  if (op.op === "set") {
    if (op.section === "umPerPx") {
      if (op.value !== null && (typeof op.value !== "number" || !(op.value > 0))) {
        throw new ToolInputError(`${at}: umPerPx must be a positive number or null`);
      }
    } else if (op.value !== null && (typeof op.value !== "object" || Array.isArray(op.value))) {
      throw new ToolInputError(`${at}: ${op.section} must be an object or null`);
    }
    return;
  }
  if (op.op === "delete") {
    const list = (working[op.section] ?? []) as { id: string }[];
    if (!list.some((x) => x.id === op.id)) throw new McpEditError(`${at}: no ${describe(op.section)} with id ${op.id}`, 404);
    if (op.section === "cellTypes" && working.cells.some((c) => c.cellTypeId === op.id)) {
      throw new McpEditError(`${at}: cell type ${op.id} still has cells; delete them first (same batch is fine)`, 409);
    }
    return;
  }
  const item = op.item as Record<string, unknown>;
  switch (op.section) {
    case "nets": {
      const net = item as unknown as AnnotationNet;
      if (typeof net.name !== "string" || !Array.isArray(net.nodes) || !Array.isArray(net.edges)) {
        throw new ToolInputError(`${at}: a net needs name, nodes [{id,x,y}] and edges [{id,from,to,layer?}]`);
      }
      const nodeIds = new Set(net.nodes.map((n) => n?.id));
      for (const n of net.nodes) {
        if (typeof n?.id !== "string" || typeof n.x !== "number" || typeof n.y !== "number") {
          throw new ToolInputError(`${at}: every net node needs a string id and numeric x, y`);
        }
      }
      for (const e of net.edges) {
        if (typeof e?.id !== "string" || !nodeIds.has(e.from) || !nodeIds.has(e.to)) {
          throw new ToolInputError(`${at}: every edge needs an id and from / to ids of nodes in the same net`);
        }
      }
      break;
    }
    case "cells":
      if (typeof item.cellTypeId !== "string" || !working.cellTypes.some((ct) => ct.id === item.cellTypeId)) {
        throw new ToolInputError(`${at}: cell.cellTypeId must reference an existing cell type`);
      }
      if (typeof item.x !== "number" || typeof item.y !== "number") throw new ToolInputError(`${at}: a cell needs numeric x, y`);
      break;
    case "cellTypes": {
      const crop = item.cropRect as Record<string, unknown> | undefined;
      if (typeof item.name !== "string" || !crop || ["x", "y", "width", "height"].some((k) => typeof crop[k] !== "number")) {
        throw new ToolInputError(`${at}: a cell type needs name and cropRect {x, y, width, height}`);
      }
      break;
    }
    case "pins":
      if (typeof item.x !== "number" || typeof item.y !== "number" || typeof item.pin !== "number" || typeof item.name !== "string") {
        throw new ToolInputError(`${at}: a pin needs x, y, pin (number) and name`);
      }
      break;
    case "annotations":
      if (typeof item.class !== "string" || !item.geometry || typeof item.geometry !== "object") {
        throw new ToolInputError(`${at}: an ML annotation / via needs class and geometry`);
      }
      break;
  }
}

function apply(working: DieAnnotations, op: Op): { target: McpTarget; id: string; after: unknown | null } {
  const record = working as unknown as Record<string, unknown>;
  if (op.op === "set") {
    if (op.value === null) delete record[op.section];
    else record[op.section] = op.value;
    return { target: op.section, id: op.section, after: op.value };
  }
  const list = (working[op.section] ?? []) as { id: string }[];
  if (op.op === "delete") {
    record[op.section] = list.filter((x) => x.id !== op.id);
    return { target: op.section, id: op.id, after: null };
  }
  const index = list.findIndex((x) => x.id === op.item.id);
  record[op.section] = index === -1 ? [...list, op.item] : list.map((x, i) => (i === index ? op.item : x));
  return { target: op.section, id: op.item.id, after: op.item };
}

const editAnnotations: ToolDef = {
  name: "edit_annotations",
  title: "Edit annotations (full)",
  description:
    "Create, replace or delete ANY annotation — nets, cells, cell types (incl. their layer shapes), pins, " +
    "vias / ML annotations, ROIs, ignore regions, guides, grids, rulers, comments, floorplan regions — or " +
    "set a whole section (analogLayers, umPerPx, mlConfig, icPackage). Items use the exact JSON shape " +
    "get_annotations returns; upsert replaces the whole item with that id. Operations apply in order and " +
    "the batch is ONE step on the MCP undo stack. Only works when the die has \"Full edits\" enabled.",
  inputSchema: {
    type: "object",
    properties: {
      description: { type: "string", description: "Short label for the MCP undo history" },
      operations: {
        type: "array",
        minItems: 1,
        maxItems: 2000,
        items: {
          type: "object",
          properties: {
            op: { type: "string", enum: ["upsert", "delete", "set"] },
            section: { type: "string", enum: [...LIST_SECTIONS, ...MCP_VALUE_SECTIONS] },
            item: { type: "object", description: "upsert: the full item, with id" },
            id: { type: "string", description: "delete: item id" },
            value: { description: "set: new section value (null removes it)" }
          },
          required: ["op", "section"]
        }
      }
    },
    required: ["operations"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
  run: async (ctx, args) => {
    if (!Array.isArray(args.operations) || args.operations.length === 0 || args.operations.length > 2000) {
      throw new ToolInputError(`"operations" must be a list of 1–2000 operations`);
    }
    const ops = args.operations.map(parseOp);
    const description = str(args, "description", true);
    return write(ctx, "full", (annotations) => {
      const working = structuredClone(annotations);
      const items: { collection: McpTarget; id: string; after: unknown | null }[] = [];
      const own: Partial<Record<keyof McpOwned, string[]>> = {};
      const counts = new Map<string, number>();
      ops.forEach((op, i) => {
        validate(working, op, i);
        const upsertId = op.op === "upsert" ? op.item.id : null;
        const existed =
          upsertId !== null && ((annotations[op.section] ?? []) as { id: string }[]).some((x) => x.id === upsertId);
        const { target, id, after } = apply(working, op);
        items.push({ collection: target, id, after });
        const ownedKey = op.op === "upsert" && !existed ? OWNED_SECTIONS[op.section] : undefined;
        if (ownedKey && op.op === "upsert") {
          own[ownedKey] = [...(own[ownedKey] ?? []), id];
          if (op.section === "nets") {
            const net = op.item as unknown as AnnotationNet;
            own.netNodes = [...(own.netNodes ?? []), ...net.nodes.map((n) => n.id)];
            own.netEdges = [...(own.netEdges ?? []), ...net.edges.map((e) => e.id)];
          }
        }
        const label = `${op.op} ${describe(op.section)}`;
        counts.set(label, (counts.get(label) ?? 0) + 1);
      });
      const auto = [...counts].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join(", ");
      return {
        tool: "edit_annotations",
        summary: description ? `${description} (${ops.length} op${ops.length > 1 ? "s" : ""})` : auto,
        items,
        own,
        result: { applied: ops.length }
      };
    });
  }
};

export const FULL_EDIT_TOOLS: ToolDef[] = [editAnnotations];
