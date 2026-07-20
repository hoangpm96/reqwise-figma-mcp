/**
 * validateOperation() — the ONE choke point.
 *
 * Both leader-direct operations (from the executor / tool handlers) and
 * follower-forwarded operations (arriving via POST /rpc) pass through this
 * function before they reach the bridge. This closes the figma-mcp-go
 * validate-bypass bug where forwarded ops skipped validation.
 *
 * Schemas are intentionally permissive on the "shape of a spec" (the plugin
 * is the single source of truth for drawing semantics) but strict on the
 * identity fields the server is responsible for: a real op name, a non-empty
 * nodeId where the op needs one, well-formed params object, sane chunk sizes.
 */
import { z } from "zod";
import {
  OPERATIONS,
  READ_OPERATIONS,
  SERVER_OPERATIONS,
  WRITE_OPERATIONS,
  type AnyOperation,
  type Operation,
} from "../shared/protocol.js";
import { ErrorCode, OpError } from "./errors.js";

const OP_SET = new Set<string>([...OPERATIONS, ...SERVER_OPERATIONS]);

/** A node id: Figma ids look like "123:456" or "I123:456;..." — we only
 *  require a non-empty trimmed string; the plugin resolves the real node. */
const nodeId = z.string().trim().min(1, "nodeId must be a non-empty string");

const params = z.record(z.unknown());

const designEvidenceParams = z
  .object({
    detail: z.enum(["sparse", "compact", "full", "design"]).optional(),
    depth: z.number().int().min(0).max(8).optional(),
    screenDepth: z.number().int().min(0).max(8).optional(),
    includeJson: z.boolean().optional(),
    includeAnatomy: z.boolean().optional(),
    includeInstances: z.boolean().optional(),
    includeScreens: z.boolean().optional(),
    includeComponentUsage: z.boolean().optional(),
    maxComponents: z.number().int().min(0).optional(),
    maxScreens: z.number().int().min(0).max(500).optional(),
    maxInstances: z.number().int().min(0).max(20_000).optional(),
    maxVariantsPerComponent: z.number().int().min(0).optional(),
    maxTextLayersPerComponent: z.number().int().min(0).optional(),
    maxOutputChars: z.number().int().positive().optional(),
  })
  .passthrough();

/** Ops that require a `nodeId` in params. */
const needsNodeId: Record<string, true> = {
  get_node: true,
  modify: true,
  delete: true,
  clone: true,
  move: true,
  resize: true,
  ungroup: true,
  flatten: true,
  apply_variable: true,
  set_text: true,
  zoom_to_fit: true,
  layout_audit: true,
  export_node: true,
  set_gradient: true,
  set_effects: true,
};

/** Per-op refinements layered on top of the base params object. */
const OP_SCHEMAS: Partial<Record<Operation, z.ZodTypeAny>> = {
  get_node: z.object({ nodeId }).passthrough(),
  get_nodes: z.object({ nodeIds: z.array(nodeId).min(1) }).passthrough(),
  modify: z.object({ nodeId, props: z.record(z.unknown()).optional() }).passthrough(),
  delete: z.object({ nodeId }).passthrough(),
  clone: z.object({ nodeId }).passthrough(),
  move: z.object({ nodeId }).passthrough(),
  resize: z.object({ nodeId }).passthrough(),
  ungroup: z.object({ nodeId }).passthrough(),
  flatten: z.object({ nodeId }).passthrough(),
  export_tokens: z
    .object({
      format: z.enum(["dtcg", "css", "tailwind"]).optional(),
      collection: z.string().trim().min(1).optional(),
      mode: z.string().trim().min(1).optional(),
      allModes: z.boolean().optional(),
      selector: z.string().trim().min(1).optional(),
    })
    .passthrough(),
  import_tokens: z
    .object({
      tokens: z.record(z.unknown()).optional(),
      dtcg: z.record(z.unknown()).optional(),
      modes: z.record(z.unknown()).optional(),
      collection: z.string().trim().min(1).optional(),
      mode: z.string().trim().min(1).optional(),
    })
    .passthrough()
    .refine((p) => p.tokens || p.dtcg || p.modes, {
      message: "import_tokens requires tokens (DTCG tree) or modes ({modeName: tree}).",
    }),
  create_variable: z
    .object({
      name: z.string().trim().min(1),
      type: z.enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"]).optional(),
      value: z.unknown().optional(),
      valuesByMode: z.record(z.unknown()).optional(),
      collection: z.string().trim().min(1).optional(),
      description: z.string().optional(),
    })
    .passthrough()
    .refine((p) => p.value !== undefined || p.valuesByMode !== undefined, {
      message: "create_variable requires value or valuesByMode.",
    }),
  update_variable: z
    .object({
      variable: z.string().trim().min(1).optional(),
      name: z.string().trim().min(1).optional(),
      variableId: z.string().trim().min(1).optional(),
    })
    .passthrough()
    .refine((p) => p.variable || p.name || p.variableId, {
      message: "update_variable requires variable (name or id).",
    }),
  rename_variable: z
    .object({
      variable: z.string().trim().min(1).optional(),
      name: z.string().trim().min(1).optional(),
      variableId: z.string().trim().min(1).optional(),
      newName: z.string().trim().min(1),
    })
    .passthrough()
    .refine((p) => p.variable || p.name || p.variableId, {
      message: "rename_variable requires variable (name or id).",
    }),
  delete_variable: z
    .object({
      variable: z.string().trim().min(1).optional(),
      name: z.string().trim().min(1).optional(),
      variableId: z.string().trim().min(1).optional(),
      replaceWith: z.string().trim().min(1).optional(),
      force: z.boolean().optional(),
    })
    .passthrough()
    .refine((p) => p.variable || p.name || p.variableId, {
      message: "delete_variable requires variable (name or id).",
    }),
  componentize: z
    .object({
      nodeId,
      name: z.string().trim().min(1).optional(),
      replaceCopies: z.boolean().optional(),
      scope: z.enum(["page", "document"]).optional(),
    })
    .passthrough(),
  set_component_description: z
    .object({
      nodeId,
      description: z.string().optional(),
      documentationLinks: z
        .array(z.object({ uri: z.string().trim().min(1) }).passthrough())
        .optional(),
    })
    .passthrough()
    .refine((p) => p.description !== undefined || p.documentationLinks !== undefined, {
      message: "set_component_description requires description and/or documentationLinks.",
    }),
  arrange_component_set: z
    .object({
      nodeId,
      gap: z.number().min(0).optional(),
      padding: z.number().min(0).optional(),
      columnsBy: z.string().trim().min(1).optional(),
    })
    .passthrough(),
  create_variants: z
    .object({
      baseSpec: z.record(z.unknown()).optional(),
      name: z.string().trim().min(1).optional(),
      axes: z
        .record(
          z
            .array(z.union([z.string(), z.number(), z.boolean()]))
            .min(1, "each axis needs at least one value"),
        )
        .optional(),
    })
    .passthrough()
    .refine(
      (p) =>
        p.axes !== undefined ||
        (p as Record<string, unknown>).variants !== undefined ||
        (p as Record<string, unknown>).states !== undefined,
      { message: "create_variants requires axes or variants/states." },
    ),
  find_or_create_component: z
    .object({
      name: z.string().trim().min(1).optional(),
      query: z.string().trim().min(1).optional(),
      spec: z.record(z.unknown()).optional(),
      dryRun: z.boolean().optional(),
      threshold: z.number().positive().optional(),
    })
    .passthrough()
    .refine((p) => p.name || p.query, {
      message: "find_or_create_component requires name or query.",
    }),
  instantiate: z
    .object({
      componentId: z.string().trim().min(1).optional(),
      component: z.string().trim().min(1).optional(),
      query: z.string().trim().min(1).optional(),
    })
    .passthrough()
    .refine((p) => p.componentId || p.component || p.query, {
      message: "instantiate requires one of: componentId, component, query.",
    }),
  apply_variable: z
    .object({ nodeId, field: z.string().trim().min(1), tokenName: z.string().trim().min(1) })
    .passthrough(),
  set_text: z
    .object({ nodeId })
    .passthrough()
    .refine(
      (p) =>
        typeof p.content === "string" ||
        typeof p.characters === "string" ||
        typeof p.text === "string",
      { message: "set_text requires one of: content, characters, text (string)." },
    ),
  zoom_to_fit: z.object({ nodeId }).passthrough(),
  layout_audit: z.object({ nodeId }).passthrough(),
  export_node: z.object({ nodeId }).passthrough(),
  create: z.object({ type: z.string().trim().min(1).optional() }).passthrough(),
  group: z.object({ nodeIds: z.array(nodeId).min(1) }).passthrough(),
  create_page: z.object({ name: z.string().trim().min(1) }).passthrough(),
  set_current_page: z
    .object({ pageId: nodeId.optional(), name: z.string().trim().min(1).optional() })
    .passthrough()
    .refine((p) => p.pageId || p.name, { message: "set_current_page requires pageId or name." }),
  load_icon: z.object({ name: z.string().trim().min(1) }).passthrough(),
  load_image: z.object({}).passthrough(),
  batch: z
    .object({ ops: z.array(z.object({ op: z.string(), params: z.record(z.unknown()) })).min(1) })
    .passthrough(),
  screenshot: params,
  get_components: params,
  get_component: z
    .object({
      componentId: nodeId.optional(),
      nodeId: nodeId.optional(),
      id: nodeId.optional(),
      key: z.string().trim().min(1).optional(),
    })
    .passthrough()
    .refine((p) => p.componentId || p.nodeId || p.id || p.key, {
      message: "get_component requires componentId, nodeId, id, or key.",
    }),
  get_library_component: z
    .object({
      key: z.string().trim().min(1, "key must be a non-empty string"),
      type: z.enum(["component", "set", "auto"]).optional(),
    })
    .passthrough(),
  get_design_system_kit: designEvidenceParams,
  generate_design_md: designEvidenceParams,

  // ---- Edit-in-place composite ops ----
  // Read the overrides of an instance. nodeId optional (defaults to selection).
  get_instance_overrides: z.object({ nodeId: nodeId.optional() }).passthrough(),
  // Format-painter: copy overrides from one instance to N target instances.
  set_instance_overrides: z
    .object({
      sourceId: z.string().trim().min(1, "sourceId must be a non-empty string"),
      targetIds: z.array(nodeId).min(1, "targetIds must list at least one target instance"),
    })
    .passthrough(),
  // Detach/reset accept one nodeId or a nodeIds batch.
  detach_instance: z
    .object({ nodeId: nodeId.optional(), nodeIds: z.array(nodeId).min(1).optional() })
    .passthrough()
    .refine((p) => p.nodeId || p.nodeIds, {
      message: "detach_instance requires nodeId or nodeIds.",
    }),
  reset_instance_overrides: z
    .object({ nodeId: nodeId.optional(), nodeIds: z.array(nodeId).min(1).optional() })
    .passthrough()
    .refine((p) => p.nodeId || p.nodeIds, {
      message: "reset_instance_overrides requires nodeId or nodeIds.",
    }),
  // Recursive recolor: swap `from` → `to` across the subtree (fills + strokes).
  set_selection_colors: z
    .object({
      nodeId: nodeId.optional(),
      from: z.string().trim().min(1).optional(),
      to: z.string().trim().min(1, "to (target color) is required"),
      includeStrokes: z.boolean().optional(),
    })
    .passthrough(),
  // Set a gradient paint on a node. Needs ≥2 stops; transform optional.
  set_gradient: z
    .object({
      nodeId,
      type: z.enum(["LINEAR", "RADIAL", "ANGULAR", "DIAMOND"]),
      stops: z
        .array(
          z.object({
            position: z.number(),
            color: z.string().trim().min(1),
          }),
        )
        .min(2, "a gradient needs at least 2 stops"),
      transform: z.unknown().optional(),
      target: z.string().trim().min(1).optional(),
    })
    .passthrough(),
  // Set effects (shadows/blurs) on a node.
  set_effects: z
    .object({
      nodeId,
      effects: z.array(
        z
          .object({
            type: z.string().trim().min(1),
            radius: z.number().optional(),
          })
          .passthrough(),
      ),
    })
    .passthrough(),
  // Deep read of the current selection in one call.
  read_selection: params,
};

export interface ValidatedOp {
  op: AnyOperation;
  params: Record<string, unknown>;
}

/**
 * Validate an operation name + params. Throws OpError(INVALID_PARAMS /
 * UNSUPPORTED_OPERATION) on failure. Returns the (possibly narrowed) params.
 * Server ops (SERVER_OPERATIONS, e.g. list_channels) validate here too but are
 * answered by the server and never dispatched to the plugin.
 */
export function validateOperation(op: string, rawParams: unknown): ValidatedOp {
  if (!OP_SET.has(op)) {
    throw new OpError(
      ErrorCode.UNSUPPORTED_OPERATION,
      `Unknown operation "${op}".`,
      `Valid operations: ${[...OPERATIONS, ...SERVER_OPERATIONS].join(", ")}.`,
    );
  }
  const operation = op as Operation;

  const baseParsed = params.safeParse(rawParams ?? {});
  if (!baseParsed.success) {
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      `params for "${op}" must be an object.`,
      "Pass params as a JSON object, e.g. { nodeId: \"12:3\" }.",
    );
  }

  // Generic nodeId presence check (covers ops without a dedicated schema).
  if (needsNodeId[operation] && !OP_SCHEMAS[operation]) {
    const nid = (baseParsed.data as Record<string, unknown>)["nodeId"];
    if (typeof nid !== "string" || nid.trim().length === 0) {
      throw new OpError(
        ErrorCode.INVALID_PARAMS,
        `Operation "${op}" requires a non-empty "nodeId".`,
        "Provide the target node id, e.g. from get_selection or a create() result.",
      );
    }
  }

  const schema = OP_SCHEMAS[operation];
  if (schema) {
    const parsed = schema.safeParse(baseParsed.data);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const path = first?.path.join(".") || "(root)";
      throw new OpError(
        ErrorCode.INVALID_PARAMS,
        `Invalid params for "${op}": ${first?.message ?? "validation failed"} at ${path}.`,
        hintFor(operation),
      );
    }
    return { op: operation, params: parsed.data as Record<string, unknown> };
  }

  return { op: operation, params: baseParsed.data as Record<string, unknown> };
}

function hintFor(op: Operation): string {
  if (needsNodeId[op]) {
    return "Check the nodeId is a non-empty string returned by a read or create op.";
  }
  if (op === "batch") {
    return "batch expects { ops: [{ op, params }, ...] }.";
  }
  return "See figma_docs(section=\"api\") for the exact parameter shape.";
}

export function isReadOp(op: string): boolean {
  // Server ops are read-only diagnostics; expose them through figma_read.
  return (
    (READ_OPERATIONS as readonly string[]).includes(op) ||
    (SERVER_OPERATIONS as readonly string[]).includes(op)
  );
}

export function isServerOp(op: string): boolean {
  return (SERVER_OPERATIONS as readonly string[]).includes(op);
}

export function isWriteOp(op: string): boolean {
  return (WRITE_OPERATIONS as readonly string[]).includes(op);
}
