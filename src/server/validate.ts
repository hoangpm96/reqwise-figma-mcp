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

const styleKind = z
  .string()
  .transform((s) => s.toUpperCase())
  .pipe(z.enum(["PAINT", "TEXT", "EFFECT", "GRID"]));

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
  set_reactions: true,
  set_text_style: true,
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
  delete_page: z
    .object({
      page: z.string().trim().min(1).optional(),
      pageId: z.string().trim().min(1).optional(),
      name: z.string().trim().min(1).optional(),
      force: z.boolean().optional(),
    })
    .passthrough()
    .refine((p) => p.page || p.pageId || p.name, {
      message: "delete_page requires page (name or id).",
    }),
  delete_style: z
    .object({
      style: z.string().trim().min(1).optional(),
      name: z.string().trim().min(1).optional(),
      styleId: z.string().trim().min(1).optional(),
      type: styleKind.optional(),
      replaceWith: z.string().trim().min(1).optional(),
      force: z.boolean().optional(),
    })
    .passthrough()
    .refine((p) => p.style || p.name || p.styleId, {
      message: "delete_style requires style (name or id).",
    }),
  delete_unused_styles: z
    .object({
      types: z.union([styleKind, z.array(styleKind).min(1)]).optional(),
      keep: z.array(z.string().trim().min(1)).optional(),
      confirm: z.string().trim().min(1).optional(),
    })
    .passthrough(),
  // The draw data is produced by the server's own layout pass, so this schema
  // guards against a hand-rolled call rather than against the layout engine.
  create_userflow: z
    .object({
      name: z.string().trim().min(1),
      title: z.string(),
      w: z.number().positive(),
      h: z.number().positive(),
      boxes: z.array(z.record(z.unknown())),
      diamonds: z.array(z.record(z.unknown())),
      edges: z.array(z.record(z.unknown())),
    })
    .passthrough(),
  // Everything is optional: with no frameId every diagram on the page is
  // re-routed, which is what "put the arrows back" usually means.
  reflow_diagram: z
    .object({
      frameId: z.string().trim().min(1).optional(),
      nodeId: z.string().trim().min(1).optional(),
      // Arrows moved by hand are left alone unless this says otherwise.
      force: z.boolean().optional(),
    })
    .passthrough(),
  // Draw data from the server's own activity layout pass.
  create_activity: z
    .object({
      name: z.string().trim().min(1),
      title: z.string(),
      w: z.number().positive(),
      h: z.number().positive(),
      lanes: z.array(z.record(z.unknown())),
      steps: z.array(z.record(z.unknown())),
      edges: z.array(z.record(z.unknown())),
    })
    .passthrough(),
  // Draw data from the server's own ERD layout pass.
  create_erd: z
    .object({
      name: z.string().trim().min(1),
      title: z.string(),
      w: z.number().positive(),
      h: z.number().positive(),
      entities: z.array(z.record(z.unknown())),
      edges: z.array(z.record(z.unknown())),
      markers: z.array(z.record(z.unknown())),
    })
    .passthrough(),
  // Draw data from the server's own sequence layout pass.
  create_sequence: z
    .object({
      name: z.string().trim().min(1),
      title: z.string(),
      w: z.number().positive(),
      h: z.number().positive(),
      participants: z.array(z.record(z.unknown())),
      messages: z.array(z.record(z.unknown())),
    })
    .passthrough(),
  // Draw data from the server's own state layout pass.
  create_state: z
    .object({
      name: z.string().trim().min(1),
      title: z.string(),
      w: z.number().positive(),
      h: z.number().positive(),
      states: z.array(z.record(z.unknown())),
      edges: z.array(z.record(z.unknown())),
    })
    .passthrough(),
  // Draw data from the server's own sitemap tidy-tree pass.
  create_sitemap: z
    .object({
      name: z.string().trim().min(1),
      title: z.string(),
      w: z.number().positive(),
      h: z.number().positive(),
      pages: z.array(z.record(z.unknown())),
      edges: z.array(z.record(z.unknown())),
    })
    .passthrough(),
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
  get_diagram_spec: z.object({ nodeId }).passthrough(),
  get_page_model: z
    .object({
      /** "page" (default, free) or "file" — every page, at the cost of loading them. */
      scope: z.enum(["page", "file"]).optional(),
      pageId: z.string().trim().min(1).optional(),
    })
    .passthrough(),
  export_node: z.object({ nodeId }).passthrough(),
  create: z.object({ type: z.string().trim().min(1).optional() }).passthrough(),
  group: z.object({ nodeIds: z.array(nodeId).min(1) }).passthrough(),
  create_page: z.object({ name: z.string().trim().min(1) }).passthrough(),
  set_current_page: z
    .object({ pageId: nodeId.optional(), name: z.string().trim().min(1).optional() })
    .passthrough()
    .refine((p) => p.pageId || p.name, { message: "set_current_page requires pageId or name." }),
  // The plugin draws the svg; `name` only labels the layer. figma.loadIcon()
  // fetches the svg server-side and always sends both.
  load_icon: z.object({ svg: z.string().min(1), name: z.string().optional() }).passthrough(),
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
  design_fingerprint: params,

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
  // Typography ramp → local text styles (upsert by name). Deep validation
  // (weights, lineHeight shapes, fonts) happens in the plugin.
  setup_text_styles: z
    .object({
      styles: z
        .array(z.object({ name: z.string().trim().min(1) }).passthrough())
        .min(1, "setup_text_styles needs at least one style"),
    })
    .passthrough(),
  // Elevation ramp → local effect styles (upsert by name). Deep validation of
  // each shadow/blur happens in the plugin.
  setup_effect_styles: z
    .object({
      styles: z
        .array(
          z
            .object({
              name: z.string().trim().min(1),
              effects: z.array(z.unknown()).min(1),
            })
            .passthrough(),
        )
        .min(1, "setup_effect_styles needs at least one style"),
    })
    .passthrough(),
  // Apply a local text style to a TEXT node by name or id.
  set_text_style: z.object({ nodeId }).passthrough(),
  // Replace a node's prototype reactions. Coarse shape only — trigger/action
  // enums and destination existence are validated in the plugin
  // (normalizeReactions), which throws INVALID_PARAMS with a precise hint.
  set_reactions: z
    .object({
      nodeId,
      reactions: z.array(z.object({}).passthrough()),
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

/**
 * The user-facing userflow spec (what an agent writes), validated BEFORE the
 * layout pass. Kept separate from OP_SCHEMAS because the op itself carries the
 * laid-out draw data, not this.
 */
const flowNode = z
  .object({
    // The id becomes part of the drawn layer's name, which is how the created
    // nodes are matched back to the graph. Whitespace there truncated the key
    // and returned a `nodes` map that did not match the graph.
    id: z
      .string()
      .trim()
      .min(1)
      .regex(/^\S+$/, "node id must not contain whitespace — it is the handle the drawn layer is named with"),
    label: z.string(),
    detail: z.string().optional(),
    kind: z.enum(["screen", "state", "decision", "external", "terminal"]).optional(),
    cls: z.enum(["happy", "error", "edge", "plain", "decision"]).optional(),
    screenId: z.string().trim().min(1).optional(),
    slug: z.string().trim().min(1).optional(),
  })
  .passthrough();

/** Where along a box's face an arrow attaches: 0 = one corner, 1 = the other. */
const portAt = z.number().min(0).max(1).optional();
/** Which face an arrow attaches to. */
const portSide = z.enum(["top", "right", "bottom", "left"]).optional();

const flowEdge = z
  .object({
    from: z.string().trim().min(1).regex(/^\S+$/, "edge `from` must be a node id (no whitespace)"),
    to: z.string().trim().min(1).regex(/^\S+$/, "edge `to` must be a node id (no whitespace)"),
    label: z.string().optional(),
    kind: z.enum(["forward", "return"]).optional(),
    fromAt: portAt,
    toAt: portAt,
    fromSide: portSide,
    toSide: portSide,
  })
  .passthrough();

export const userflowSpecSchema = z
  .object({
    title: z.string().trim().min(1),
    subtitle: z.string().optional(),
    /** The compact line form; parsed in src/shared/<kind>/text.ts. */
    text: z.string().optional(),
    parentId: z.string().trim().min(1).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    nodes: z.array(flowNode).optional(),
    edges: z.array(flowEdge).optional(),
    mermaid: z.string().optional(),
    options: z
      .object({
        rankdir: z.enum(["TB", "LR"]).optional(),
        font: z.string().trim().min(1).optional(),
        colorByTarget: z.boolean().optional(),
        linkScreens: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        checkFirst: z.boolean().optional(),
        verify: z.boolean().optional(),
        crossCheck: z.boolean().optional(),
        policies: z.record(z.union([z.string(), z.number()])).optional(),
        liveRoute: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .refine((p) => (p.nodes && p.nodes.length > 0) || (p.mermaid && p.mermaid.trim().length > 0), {
    message:
      "userflow needs nodes[] (with edges[]) or a mermaid source — the graph comes from YOUR analysis of the spec, not from the tool.",
  });

/**
 * Does a diagram spec carry compact `text` to parse? The builders take `text`
 * only when it has something besides whitespace, so an empty or blank `text`
 * beside valid arrays draws the arrays — the spec refines must agree, or they
 * veto a spec the builder would draw correctly.
 */
function hasText(text: unknown): boolean {
  return typeof text === "string" && text.trim().length > 0;
}

/** Parse a userflow spec or throw the standard INVALID_PARAMS OpError. */
export function validateUserflowSpec(spec: unknown): Record<string, unknown> {
  const parsed = userflowSpecSchema.safeParse(spec ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join(".") || "(root)";
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      `Invalid userflow spec: ${first?.message ?? "validation failed"} at ${path}.`,
      'Shape: { title, nodes:[{id,label,kind,cls,screenId}], edges:[{from,to,label,kind}] } or { title, mermaid }. See figma_docs(section="userflow").',
    );
  }
  return parsed.data as Record<string, unknown>;
}

/**
 * An id the plugin names a drawn layer with (`step:<id>`, `state:<id>`,
 * `entity:<id>`, `party:<id>` …) and reads back with `[^\s]+`. An id with a
 * space in it is cut at the space on the way back, so "Order Line" and
 * "Order Header" both come back as "Order" and one box is taken for the
 * other. The references to such an id (`from`, `to`, `lane`) are held to the
 * same rule, so a mismatch is reported where it is written.
 */
const layerId = (what: string) =>
  z
    .string()
    .trim()
    .min(1)
    .regex(/^\S+$/, `${what} must not contain whitespace — it is the handle the drawn layer is named with`);

// ---- the user-facing activity spec (what an agent writes) ----

const laneSpec = z
  .object({
    id: layerId("lane id"),
    label: z.string().trim().min(1),
    detail: z.string().optional(),
  })
  .passthrough();

const activityNode = z
  .object({
    id: layerId("step id"),
    label: z.string(),
    detail: z.string().optional(),
    // Required as soon as the diagram has lanes — an unowned step is the
    // drawing this tool exists to prevent. Omitted on EVERY step, it is a
    // plain activity diagram with no swimlanes, which is a real thing to want.
    lane: layerId("step `lane`").optional(),
    kind: z
      .enum(["action", "decision", "start", "end", "fork", "join", "event", "external"])
      .optional(),
    cls: z.enum(["happy", "error", "edge", "plain", "decision"]).optional(),
  })
  .passthrough();

const activityEdge = z
  .object({
    from: layerId("edge `from`"),
    to: layerId("edge `to`"),
    label: z.string().optional(),
    kind: z.enum(["forward", "return"]).optional(),
    fromAt: portAt,
    toAt: portAt,
    fromSide: portSide,
    toSide: portSide,
  })
  .passthrough();

export const activitySpecSchema = z
  .object({
    title: z.string().trim().min(1),
    subtitle: z.string().optional(),
    /** The compact line form; parsed in src/shared/<kind>/text.ts. */
    text: z.string().optional(),
    parentId: z.string().trim().min(1).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    lanes: z.array(laneSpec).optional().optional(),
    nodes: z.array(activityNode).optional(),
    edges: z.array(activityEdge).optional().optional(),
    options: z
      .object({
        rankdir: z.enum(["TB", "LR"]).optional(),
        font: z.string().trim().min(1).optional(),
        colorByTarget: z.boolean().optional(),
        liveRoute: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        checkFirst: z.boolean().optional(),
        verify: z.boolean().optional(),
        crossCheck: z.boolean().optional(),
        policies: z.record(z.union([z.string(), z.number()])).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .refine((sp) => hasText(sp.text) || (Array.isArray(sp.nodes) && sp.nodes.length > 0), {
    message: "Pass either `text` (the compact line form, e.g. `sys: pay ? 'Paid?'`) or lanes / nodes / edges. `text` is roughly a third of the tokens; figma_docs({ section, level: 'cheat' }) has the grammar.",
  });

/** Parse an activity spec or throw the standard INVALID_PARAMS OpError. */
export function validateActivitySpec(spec: unknown): Record<string, unknown> {
  const parsed = activitySpecSchema.safeParse(spec ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join(".") || "(root)";
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      `Invalid activity spec: ${first?.message ?? "validation failed"} at ${path}.`,
      'Shape: { title, lanes:[{id,label}], nodes:[{id,label,lane,kind,cls}], edges:[{from,to,label,kind}] }. With lanes[], every node needs its `lane`; drop both for a plain activity diagram with no swimlanes. See figma_docs(section="activity").',
    );
  }
  return parsed.data as Record<string, unknown>;
}

// ---- the user-facing state-machine spec ----

const stateNode = z
  .object({
    id: layerId("state id"),
    label: z.string().optional(),
    kind: z.enum(["state", "initial", "final", "choice", "fork", "join"]).optional(),
    entry: z.string().optional(),
    do: z.string().optional(),
    exit: z.string().optional(),
    detail: z.string().optional(),
    cls: z.enum(["happy", "error", "edge", "plain", "decision"]).optional(),
  })
  .passthrough();

const transition = z
  .object({
    from: layerId("transition `from`"),
    to: layerId("transition `to`"),
    event: z.string().optional(),
    guard: z.string().optional(),
    action: z.string().optional(),
    kind: z.enum(["forward", "return"]).optional(),
    cls: z.enum(["happy", "error", "edge", "plain", "decision"]).optional(),
    fromAt: z.number().optional(),
    toAt: z.number().optional(),
    fromSide: portSide,
    toSide: portSide,
  })
  .passthrough();

export const stateSpecSchema = z
  .object({
    title: z.string().trim().min(1),
    subtitle: z.string().optional(),
    /** The compact line form; parsed in src/shared/<kind>/text.ts. */
    text: z.string().optional(),
    parentId: z.string().trim().min(1).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    states: z.array(stateNode).optional(),
    transitions: z.array(transition).optional().optional(),
    options: z
      .object({
        rankdir: z.enum(["TB", "LR"]).optional(),
        font: z.string().trim().min(1).optional(),
        colorByTarget: z.boolean().optional(),
        liveRoute: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        checkFirst: z.boolean().optional(),
        verify: z.boolean().optional(),
        crossCheck: z.boolean().optional(),
        policies: z.record(z.union([z.string(), z.number()])).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .refine((sp) => hasText(sp.text) || (Array.isArray(sp.states) && sp.states.length > 0), {
    message: "Pass either `text` (the compact line form, e.g. `held -> paying: Confirm [guard] / action`) or states / transitions. `text` is roughly a third of the tokens; figma_docs({ section, level: 'cheat' }) has the grammar.",
  });

/** Parse a state spec or throw the standard INVALID_PARAMS OpError. */
export function validateStateSpec(spec: unknown): Record<string, unknown> {
  const parsed = stateSpecSchema.safeParse(spec ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join(".") || "(root)";
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      `Invalid state spec: ${first?.message ?? "validation failed"} at ${path}.`,
      'Shape: { title, states:[{id,label,kind,entry,do,exit}], transitions:[{from,to,event,guard,action}] }. One state must be kind:"initial". See figma_docs(section="state").',
    );
  }
  return parsed.data as Record<string, unknown>;
}

// ---- the user-facing ERD spec ----

const cardinality = z.enum(["one", "many", "zero-one", "zero-many", "one-many"]).optional();

const erdAttribute = z
  .object({
    name: z.string().trim().min(1),
    type: z.string().optional(),
    key: z.enum(["pk", "fk", "pfk"]).optional(),
    required: z.boolean().optional(),
  })
  .passthrough();

const erdEntity = z
  .object({
    id: layerId("entity id"),
    name: z.string().trim().min(1),
    detail: z.string().optional(),
    attributes: z.array(erdAttribute),
    cls: z.enum(["happy", "error", "edge", "plain", "decision"]).optional(),
    external: z.boolean().optional(),
  })
  .passthrough();

const erdRelation = z
  .object({
    from: layerId("relation `from`"),
    to: layerId("relation `to`"),
    fromCard: cardinality,
    toCard: cardinality,
    label: z.string().optional(),
    fromField: z.string().optional(),
    toField: z.string().optional(),
    identifying: z.boolean().optional(),
    fromSide: portSide,
    toSide: portSide,
  })
  .passthrough();

export const erdSpecSchema = z
  .object({
    title: z.string().trim().min(1),
    subtitle: z.string().optional(),
    /** The compact line form; parsed in src/shared/<kind>/text.ts. */
    text: z.string().optional(),
    parentId: z.string().trim().min(1).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    entities: z.array(erdEntity).optional(),
    relations: z.array(erdRelation).optional().optional(),
    options: z
      .object({
        rankdir: z.enum(["TB", "LR"]).optional(),
        font: z.string().trim().min(1).optional(),
        liveRoute: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        checkFirst: z.boolean().optional(),
        verify: z.boolean().optional(),
        crossCheck: z.boolean().optional(),
        policies: z.record(z.union([z.string(), z.number()])).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .refine((sp) => hasText(sp.text) || (Array.isArray(sp.entities) && sp.entities.length > 0), {
    message: "Pass either `text` (the compact line form, e.g. `users.id 1-* bookings.user_id 'books'`) or entities / relations. `text` is roughly a third of the tokens; figma_docs({ section, level: 'cheat' }) has the grammar.",
  });

/** Parse an ERD spec or throw the standard INVALID_PARAMS OpError. */
export function validateErdSpec(spec: unknown): Record<string, unknown> {
  const parsed = erdSpecSchema.safeParse(spec ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join(".") || "(root)";
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      `Invalid ERD spec: ${first?.message ?? "validation failed"} at ${path}.`,
      'Shape: { title, entities:[{id,name,attributes:[{name,type,key}]}], relations:[{from,to,fromField,toField,toCard}] }. See figma_docs(section="erd").',
    );
  }
  return parsed.data as Record<string, unknown>;
}

// ---- the user-facing sequence spec ----

const seqParticipant = z
  .object({
    id: layerId("participant id"),
    name: z.string().trim().min(1),
    detail: z.string().optional(),
    kind: z.enum(["actor", "system", "external", "queue", "db"]).optional(),
    cls: z.enum(["happy", "error", "edge", "plain", "decision"]).optional(),
  })
  .passthrough();

const seqMessage = z
  .object({
    id: layerId("message id"),
    from: layerId("message `from`"),
    to: layerId("message `to`"),
    label: z.string(),
    kind: z.enum(["sync", "async", "return"]).optional(),
    note: z.string().optional(),
    cls: z.enum(["happy", "error", "edge", "plain", "decision"]).optional(),
  })
  .passthrough();

const seqFragment = z
  .object({
    kind: z.enum(["alt", "opt", "loop", "par", "break"]),
    label: z.string(),
    messages: z.array(z.string().trim().min(1)).min(1),
    else: z
      .object({ label: z.string().optional(), messages: z.array(z.string().trim().min(1)).min(1) })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const sequenceSpecSchema = z
  .object({
    title: z.string().trim().min(1),
    subtitle: z.string().optional(),
    /** The compact line form; parsed in src/shared/<kind>/text.ts. */
    text: z.string().optional(),
    parentId: z.string().trim().min(1).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    participants: z.array(seqParticipant).optional(),
    messages: z.array(seqMessage).optional(),
    fragments: z.array(seqFragment).optional().optional(),
    options: z
      .object({
        font: z.string().trim().min(1).optional(),
        liveRoute: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        checkFirst: z.boolean().optional(),
        verify: z.boolean().optional(),
        crossCheck: z.boolean().optional(),
        policies: z.record(z.union([z.string(), z.number()])).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .refine((sp) => hasText(sp.text) || (Array.isArray(sp.messages) && sp.messages.length > 0), {
    message: "Pass either `text` (the compact line form, e.g. `u ->> api: POST /pay`) or participants / messages / fragments. `text` is roughly a third of the tokens; figma_docs({ section, level: 'cheat' }) has the grammar.",
  });

/** Parse a sequence spec or throw the standard INVALID_PARAMS OpError. */
export function validateSequenceSpec(spec: unknown): Record<string, unknown> {
  const parsed = sequenceSpecSchema.safeParse(spec ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join(".") || "(root)";
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      `Invalid sequence spec: ${first?.message ?? "validation failed"} at ${path}.`,
      'Shape: { title, participants:[{id,name,kind}], messages:[{id,from,to,label,kind}], fragments:[{kind,label,messages}] }. Messages are drawn in the order given — that IS the time order. See figma_docs(section="sequence").',
    );
  }
  return parsed.data as Record<string, unknown>;
}

// ---- the user-facing sitemap spec ----

const sitemapPage = z
  .object({
    // The id becomes part of the drawn layer's name, which is how the created
    // boxes are matched back to the tree and how a reflow finds them again.
    id: z
      .string()
      .trim()
      .min(1)
      .regex(/^\S+$/, "page id must not contain whitespace — it is the handle the drawn layer is named with"),
    label: z.string().optional(),
    // The page this one LIVES UNDER. Not the page you came from: a sitemap
    // edge is containment, and there is deliberately no edge array to write a
    // navigation step into.
    parent: z.string().trim().min(1).optional(),
    kind: z.enum(["page", "section", "modal", "external"]).optional(),
    detail: z.string().optional(),
    // A page is usually several artboards — itself plus its states. A bare
    // string is one artboard and stays valid; see PageSpec for why the list.
    screenId: z
      .union([z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1)])
      .optional(),
    cls: z.enum(["happy", "error", "edge", "plain", "decision"]).optional(),
  })
  .passthrough();

export const sitemapSpecSchema = z
  .object({
    title: z.string().trim().min(1),
    subtitle: z.string().optional(),
    /** The compact line form; parsed in src/shared/sitemap/text.ts. */
    text: z.string().optional(),
    parentId: z.string().trim().min(1).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    pages: z.array(sitemapPage).optional(),
    options: z
      .object({
        rankdir: z.enum(["TB", "LR"]).optional(),
        // `options.layout` is ONE field in the tool schema, shared with other
        // kinds whose values mean nothing here. The JSON enum is the union of
        // every kind's values and this is the only thing that knows which ones
        // are legal for a sitemap — so another kind's shape passed to a
        // sitemap is refused here rather than silently drawing a tree.
        layout: z.enum(["tree", "dagre"]).optional(),
        font: z.string().trim().min(1).optional(),
        colorByTarget: z.boolean().optional(),
        liveRoute: z.boolean().optional(),
        maxDepth: z.number().int().min(1).max(12).optional(),
        dryRun: z.boolean().optional(),
        checkFirst: z.boolean().optional(),
        verify: z.boolean().optional(),
        crossCheck: z.boolean().optional(),
        policies: z.record(z.union([z.string(), z.number()])).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .refine(
    (sp) =>
      hasText(sp.text) || (Array.isArray(sp.pages) && sp.pages.length > 0),
    {
      message:
        "Pass either `text` (the compact line form — one line per page, INDENTED under the page that contains it) or `pages`. `text` is roughly a third of the tokens; figma_docs({ section: \"sitemap\", level: \"cheat\" }) has the grammar.",
    },
  );

/** Parse a sitemap spec or throw the standard INVALID_PARAMS OpError. */
export function validateSitemapSpec(spec: unknown): Record<string, unknown> {
  const parsed = sitemapSpecSchema.safeParse(spec ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join(".") || "(root)";
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      `Invalid sitemap spec: ${first?.message ?? "validation failed"} at ${path}.`,
      'Shape: { title, pages:[{id, label, parent, kind, screenId}] }. `parent` is the page this one LIVES UNDER — a sitemap edge is containment, not navigation, and there is no edges array. See figma_docs(section="sitemap").',
    );
  }
  return parsed.data as Record<string, unknown>;
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
