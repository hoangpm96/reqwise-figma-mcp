/**
 * Pure edit-in-place helpers. NO figma globals — every function here operates
 * on plain data so it is unit-testable without the plugin runtime. The figma
 * handlers (instance-overrides.ts, paint-edit.ts) wrap these to touch the API.
 */
import { hexToRgb, hexToRgba, RGB, RGBA } from "./color-util.js";

// ---------------------------------------------------------------------------
// Recolor matching (set_selection_colors)
// ---------------------------------------------------------------------------

/** A near-comparison tolerance for 0..1 color channels (≈1/255). */
export const COLOR_EPSILON = 0.004;

/** Are two 0..1 RGB colors equal within COLOR_EPSILON per channel? */
export function rgbNearlyEqual(a: RGB, b: RGB, eps = COLOR_EPSILON): boolean {
  return (
    Math.abs(a.r - b.r) <= eps &&
    Math.abs(a.g - b.g) <= eps &&
    Math.abs(a.b - b.b) <= eps
  );
}

/**
 * Decide whether a SOLID fill/stroke of color `current` should be recolored,
 * given an optional `from` filter. When `from` is undefined every solid color
 * matches; when provided only colors near that hex match.
 */
export function shouldRecolor(current: RGB, from?: string): boolean {
  if (from === undefined) return true;
  return rgbNearlyEqual(current, hexToRgb(from));
}

// ---------------------------------------------------------------------------
// Gradient transform defaults (set_gradient)
// ---------------------------------------------------------------------------

export type GradientKind = "LINEAR" | "RADIAL" | "ANGULAR" | "DIAMOND";

const GRADIENT_TYPE_MAP: Record<GradientKind, string> = {
  LINEAR: "GRADIENT_LINEAR",
  RADIAL: "GRADIENT_RADIAL",
  ANGULAR: "GRADIENT_ANGULAR",
  DIAMOND: "GRADIENT_DIAMOND",
};

/** Map the friendly gradient kind → Figma paint type. Throws on unknown. */
export function gradientPaintType(kind: string): string {
  const k = String(kind).toUpperCase() as GradientKind;
  const mapped = GRADIENT_TYPE_MAP[k];
  if (!mapped) {
    throw new Error(
      `Unknown gradient type "${kind}". Use LINEAR|RADIAL|ANGULAR|DIAMOND.`,
    );
  }
  return mapped;
}

/**
 * Sensible default gradientTransform. Figma's transform is a 2x3 affine matrix
 * mapping the paint's [0..1]² gradient space onto the node. Identity
 * ([[1,0,0],[0,1,0]]) gives a left→right linear gradient; radial/angular/diamond
 * read the same identity as a centered gradient, which is what agents expect.
 * This is the matrix agents most often get wrong, so we package it.
 */
export function defaultGradientTransform(_kind: string): number[][] {
  return [
    [1, 0, 0],
    [0, 1, 0],
  ];
}

/** Validate a caller-supplied transform is a 2x3 numeric matrix. */
export function isValidGradientTransform(t: unknown): t is number[][] {
  return (
    Array.isArray(t) &&
    t.length === 2 &&
    t.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 3 &&
        row.every((n) => typeof n === "number" && isFinite(n)),
    )
  );
}

export interface NormalizedStop {
  position: number;
  color: RGBA;
}

/**
 * Normalize gradient stops: parse hex → RGBA, apply optional per-stop opacity,
 * clamp position to 0..1, and fill in evenly-spaced positions when omitted.
 * Requires ≥1 stop.
 */
export function normalizeGradientStops(stops: unknown): NormalizedStop[] {
  if (!Array.isArray(stops) || stops.length === 0) {
    throw new Error("set_gradient requires a non-empty stops[] array.");
  }
  const n = stops.length;
  return stops.map((raw, i) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const pos =
      typeof s.position === "number"
        ? clampUnit(s.position)
        : n > 1
          ? i / (n - 1)
          : 0;
    // A missing/wrong-typed color used to become opaque black — silently,
    // against the rule every other color path in this codebase keeps.
    if (typeof s.color !== "string" || s.color.length === 0) {
      throw new Error(
        `Gradient stop ${i + 1} requires a hex color string (got ${JSON.stringify(s.color)}).`,
      );
    }
    const color = hexToRgba(s.color);
    if (typeof s.opacity === "number") color.a = clampUnit(s.opacity);
    return { position: pos, color };
  });
}

function clampUnit(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ---------------------------------------------------------------------------
// Effect normalization (set_effects)
// ---------------------------------------------------------------------------

export type EffectType =
  | "DROP_SHADOW"
  | "INNER_SHADOW"
  | "LAYER_BLUR"
  | "BACKGROUND_BLUR";

export interface NormalizedShadow {
  type: "DROP_SHADOW" | "INNER_SHADOW";
  color: RGBA;
  offset: { x: number; y: number };
  radius: number;
  spread: number;
  visible: boolean;
  blendMode: string;
}

export interface NormalizedBlur {
  type: "LAYER_BLUR" | "BACKGROUND_BLUR";
  radius: number;
  visible: boolean;
}

export type NormalizedEffect = NormalizedShadow | NormalizedBlur;

const SHADOW_TYPES = new Set(["DROP_SHADOW", "INNER_SHADOW"]);
const BLUR_TYPES = new Set(["LAYER_BLUR", "BACKGROUND_BLUR"]);

/**
 * Normalize ONE effect spec into a Figma-shaped Effect object. Shadows require
 * {color, offset, spread}; blurs require only {radius}. This packages the shape
 * agents commonly get wrong (e.g. supplying offset/color on a blur, or omitting
 * spread/blendMode on a shadow).
 */
export function normalizeEffect(spec: unknown): NormalizedEffect {
  const s = (spec ?? {}) as Record<string, unknown>;
  const type = String(s.type ?? "DROP_SHADOW").toUpperCase();

  if (typeof s.radius !== "number" || !isFinite(s.radius) || s.radius < 0) {
    throw new Error(
      `Effect "${type}" requires a non-negative numeric radius.`,
    );
  }
  const visible = s.visible !== false;

  if (SHADOW_TYPES.has(type)) {
    const color =
      typeof s.color === "string"
        ? hexToRgba(s.color)
        : { r: 0, g: 0, b: 0, a: 0.25 };
    const off = (s.offset ?? {}) as { x?: unknown; y?: unknown };
    const offset = {
      x: typeof off.x === "number" ? off.x : 0,
      y: typeof off.y === "number" ? off.y : 2,
    };
    return {
      type: type as "DROP_SHADOW" | "INNER_SHADOW",
      color,
      offset,
      radius: s.radius,
      spread: typeof s.spread === "number" ? s.spread : 0,
      visible,
      blendMode: typeof s.blendMode === "string" ? s.blendMode : "NORMAL",
    };
  }

  if (BLUR_TYPES.has(type)) {
    return {
      type: type as "LAYER_BLUR" | "BACKGROUND_BLUR",
      radius: s.radius,
      visible,
    };
  }

  throw new Error(
    `Unknown effect type "${type}". Use DROP_SHADOW|INNER_SHADOW|LAYER_BLUR|BACKGROUND_BLUR.`,
  );
}

/** Normalize a list (or single) effect spec. */
export function normalizeEffects(spec: unknown): NormalizedEffect[] {
  // An empty array is a deliberate "clear all effects" — the validator already
  // allows it, so accept it here too (previously this threw, a validator/plugin
  // mismatch) and let the caller assign node.effects = [].
  if (Array.isArray(spec) && spec.length === 0) return [];
  const list = Array.isArray(spec) ? spec : [spec];
  return list.map(normalizeEffect);
}

// ---------------------------------------------------------------------------
// Prototype reactions (set_reactions)
// ---------------------------------------------------------------------------

const REACTION_TRIGGER_TYPES = new Set([
  "ON_CLICK",
  "ON_HOVER",
  "ON_PRESS",
  "ON_DRAG",
  "AFTER_TIMEOUT",
  "MOUSE_ENTER",
  "MOUSE_LEAVE",
  "MOUSE_UP",
  "MOUSE_DOWN",
]);

const NAVIGATION_TYPES = new Set([
  "NAVIGATE",
  "SWAP",
  "OVERLAY",
  "SCROLL_TO",
  "CHANGE_TO",
]);

/** Transitions with no direction (SimpleTransition). */
const SIMPLE_TRANSITION_TYPES = new Set([
  "DISSOLVE",
  "SMART_ANIMATE",
  "SCROLL_ANIMATE",
]);
/** Transitions that carry a direction (DirectionalTransition). */
const DIRECTIONAL_TRANSITION_TYPES = new Set([
  "MOVE_IN",
  "MOVE_OUT",
  "PUSH",
  "SLIDE_IN",
  "SLIDE_OUT",
]);
const TRANSITION_DIRECTIONS = new Set(["LEFT", "RIGHT", "TOP", "BOTTOM"]);

const EASING_TYPES = new Set([
  "EASE_IN",
  "EASE_OUT",
  "EASE_IN_AND_OUT",
  "LINEAR",
  "EASE_IN_BACK",
  "EASE_OUT_BACK",
  "EASE_IN_AND_OUT_BACK",
  "GENTLE",
  "QUICK",
  "BOUNCY",
  "SLOW",
]);

export interface NormalizedReaction {
  trigger: Record<string, unknown>;
  /** Modern Reaction shape; `action` mirrors actions[0] for older runtimes. */
  actions: Array<Record<string, unknown>>;
  action: Record<string, unknown>;
}

function normalizeReactionTransition(
  spec: unknown,
): Record<string, unknown> | null {
  if (spec === null) return null; // instant
  if (spec === undefined) {
    return {
      type: "SMART_ANIMATE",
      easing: { type: "EASE_IN_AND_OUT" },
      duration: 0.3,
    };
  }
  const t = (typeof spec === "object" ? spec : {}) as Record<string, unknown>;
  const type = String(t.type ?? "SMART_ANIMATE").toUpperCase();
  if (!SIMPLE_TRANSITION_TYPES.has(type) && !DIRECTIONAL_TRANSITION_TYPES.has(type)) {
    throw new Error(
      `Unknown transition type "${type}". Use DISSOLVE|SMART_ANIMATE|SCROLL_ANIMATE|MOVE_IN|MOVE_OUT|PUSH|SLIDE_IN|SLIDE_OUT, or transition:null for instant.`,
    );
  }
  const easingSpec = (t.easing ?? {}) as Record<string, unknown>;
  const easingType = String(easingSpec.type ?? "EASE_IN_AND_OUT").toUpperCase();
  if (!EASING_TYPES.has(easingType)) {
    throw new Error(
      `Unknown easing type "${easingType}". Use EASE_IN|EASE_OUT|EASE_IN_AND_OUT|LINEAR|GENTLE|QUICK|BOUNCY|SLOW|EASE_IN_BACK|EASE_OUT_BACK|EASE_IN_AND_OUT_BACK.`,
    );
  }
  const duration =
    typeof t.duration === "number" && isFinite(t.duration) && t.duration >= 0
      ? t.duration
      : t.duration === undefined
        ? 0.3
        : (() => {
            throw new Error(
              `Transition duration must be a non-negative number of seconds (got ${JSON.stringify(t.duration)}).`,
            );
          })();
  const out: Record<string, unknown> = {
    type,
    easing: { type: easingType },
    duration,
  };
  if (DIRECTIONAL_TRANSITION_TYPES.has(type)) {
    const direction = String(t.direction ?? "LEFT").toUpperCase();
    if (!TRANSITION_DIRECTIONS.has(direction)) {
      throw new Error(
        `Unknown transition direction "${direction}". Use LEFT|RIGHT|TOP|BOTTOM.`,
      );
    }
    out.direction = direction;
    out.matchLayers = t.matchLayers === true;
  }
  return out;
}

function normalizeReactionAction(spec: unknown): Record<string, unknown> {
  const a = (typeof spec === "object" && spec !== null ? spec : {}) as Record<
    string,
    unknown
  >;
  // Accept both destinationId and destination (string or {id}).
  const destRaw = a.destinationId ?? a.destination;
  const destinationId =
    typeof destRaw === "string"
      ? destRaw
      : destRaw && typeof destRaw === "object" && "id" in destRaw
        ? String((destRaw as { id: unknown }).id)
        : undefined;
  const type = String(
    a.type ?? (destinationId !== undefined ? "NODE" : ""),
  ).toUpperCase();

  if (type === "BACK" || type === "CLOSE") return { type };
  if (type === "URL") {
    if (typeof a.url !== "string" || a.url.length === 0) {
      throw new Error('Action type "URL" requires a non-empty url string.');
    }
    return { type, url: a.url };
  }
  if (type !== "NODE") {
    throw new Error(
      `Unknown reaction action type "${type || "(missing)"}". Use NODE|BACK|CLOSE|URL.`,
    );
  }

  if (destinationId === undefined || destinationId.length === 0) {
    throw new Error(
      'Action type "NODE" requires destinationId (the id of the frame to navigate to).',
    );
  }
  const navigation = String(a.navigation ?? "NAVIGATE").toUpperCase();
  if (!NAVIGATION_TYPES.has(navigation)) {
    throw new Error(
      `Unknown navigation "${navigation}". Use NAVIGATE|SWAP|OVERLAY|SCROLL_TO|CHANGE_TO.`,
    );
  }
  return {
    type: "NODE",
    destinationId,
    navigation,
    transition: normalizeReactionTransition(a.transition),
    preserveScrollPosition: a.preserveScrollPosition === true,
  };
}

/**
 * Normalize ONE reaction spec ({trigger, action|actions}) into a Figma-shaped
 * Reaction. Enum mistakes throw — never a silent no-op.
 */
export function normalizeReaction(spec: unknown): NormalizedReaction {
  const s = (typeof spec === "object" && spec !== null ? spec : {}) as Record<
    string,
    unknown
  >;
  const trig = (typeof s.trigger === "object" && s.trigger !== null
    ? s.trigger
    : {}) as Record<string, unknown>;
  const trigType = String(trig.type ?? "").toUpperCase();
  if (!REACTION_TRIGGER_TYPES.has(trigType)) {
    throw new Error(
      `Unknown reaction trigger "${trigType || "(missing)"}". Use ON_CLICK|ON_HOVER|ON_PRESS|ON_DRAG|AFTER_TIMEOUT|MOUSE_ENTER|MOUSE_LEAVE|MOUSE_UP|MOUSE_DOWN.`,
    );
  }
  const trigger: Record<string, unknown> = { type: trigType };
  if (trigType === "AFTER_TIMEOUT") {
    // The spec speaks seconds like every other duration here; Figma stores
    // AFTER_TIMEOUT.timeout in MILLISECONDS — passing seconds through made
    // every after-delay fire ~1000× early.
    const timeout = trig.timeout ?? trig.delay;
    const seconds =
      typeof timeout === "number" && isFinite(timeout) && timeout >= 0
        ? timeout
        : 0.8;
    trigger.timeout = Math.round(seconds * 1000);
  } else if (trigType.startsWith("MOUSE_")) {
    // Mouse triggers carry `delay` (also milliseconds), and MOUSE_ENTER/LEAVE
    // additionally require `deprecatedVersion` or Figma rejects the trigger.
    const delay = trig.delay ?? trig.timeout;
    const seconds =
      typeof delay === "number" && isFinite(delay) && delay >= 0 ? delay : 0;
    trigger.delay = Math.round(seconds * 1000);
    if (trigType === "MOUSE_ENTER" || trigType === "MOUSE_LEAVE") {
      trigger.deprecatedVersion = false;
    }
  }

  const actionSpecs = Array.isArray(s.actions)
    ? s.actions
    : s.action !== undefined
      ? [s.action]
      : [];
  if (actionSpecs.length === 0) {
    throw new Error(
      'A reaction requires an action, e.g. {type:"NODE", destinationId, navigation:"NAVIGATE"}.',
    );
  }
  const actions = actionSpecs.map(normalizeReactionAction);
  return { trigger, actions, action: actions[0]! };
}

/** Normalize a list (or single) reaction spec. `[]` clears all reactions. */
export function normalizeReactions(spec: unknown): NormalizedReaction[] {
  if (Array.isArray(spec) && spec.length === 0) return [];
  if (spec === undefined || spec === null) {
    throw new Error(
      "set_reactions requires a reactions array ([] clears all reactions).",
    );
  }
  const list = Array.isArray(spec) ? spec : [spec];
  return list.map(normalizeReaction);
}

// ---------------------------------------------------------------------------
// Instance override diff shape (get/set_instance_overrides)
// ---------------------------------------------------------------------------

export interface OverrideSummary {
  sourceInstanceId: string;
  mainComponentId: string | null;
  /** Ids (relative to the instance) whose properties were overridden. */
  overriddenNodeIds: string[];
  /** componentProperties snapshot (name → value). */
  componentProperties: Record<string, unknown>;
  /** exposed nested instances, by id. */
  exposedInstanceIds: string[];
}

/**
 * Build the portable override-summary shape returned by get_instance_overrides
 * and consumed by set_instance_overrides. Pure — takes already-extracted data
 * so it can be tested without the figma runtime.
 */
export function buildOverrideSummary(input: {
  sourceInstanceId: string;
  mainComponentId: string | null;
  overriddenNodeIds: string[];
  componentProperties: Record<string, unknown>;
  exposedInstanceIds: string[];
}): OverrideSummary {
  return {
    sourceInstanceId: input.sourceInstanceId,
    mainComponentId: input.mainComponentId,
    overriddenNodeIds: [...input.overriddenNodeIds],
    componentProperties: { ...input.componentProperties },
    exposedInstanceIds: [...input.exposedInstanceIds],
  };
}

/**
 * Flatten Figma componentProperties (each value is {type, value, ...}) into a
 * plain name→value map suitable for setProperties(). Skips INSTANCE_SWAP-only
 * metadata that cannot be re-applied blindly is left to the caller.
 */
export function flattenComponentProperties(
  props: Record<string, { type?: string; value?: unknown }> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!props) return out;
  for (const [name, def] of Object.entries(props)) {
    if (def && typeof def === "object" && "value" in def) {
      out[name] = (def as { value: unknown }).value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Component property name resolution (instances and their properties)
// ---------------------------------------------------------------------------

/** One entry of InstanceNode.componentProperties, as plain data. */
export interface ComponentPropertyEntry {
  type?: string;
  value?: unknown;
}

/** A VariableAlias, restated locally so this module stays figma-free. */
export interface PropVariableAlias {
  type: "VARIABLE_ALIAS";
  id: string;
}

/** The value kinds setProperties() accepts. */
export type PropertyValue = string | boolean | PropVariableAlias;

/** Everything before the "#1:2" suffix Figma appends to non-VARIANT props. */
export function propertyBaseName(key: string): string {
  const hash = key.indexOf("#");
  return hash === -1 ? key : key.slice(0, hash);
}

export interface PropertyKeyMatch {
  /** The exact key to pass to setProperties, or null when unresolved. */
  key: string | null;
  error?: string;
  /** Keys worth showing the caller when the match failed. */
  candidates?: string[];
}

/**
 * Map a caller-written property name onto a real componentProperties key.
 *
 * Figma suffixes TEXT/BOOLEAN/INSTANCE_SWAP property names with "#1:2", which
 * nobody wants to type and which changes per component. So "Show Banner",
 * "Show Banner#12:3" and "show banner" all resolve to the same key — but an
 * ambiguous or unknown name is reported, never silently dropped.
 */
export function resolvePropertyKey(
  available: Record<string, ComponentPropertyEntry>,
  name: string,
): PropertyKeyMatch {
  const keys = Object.keys(available);
  if (keys.includes(name)) return { key: name };

  const exact = keys.filter((k) => propertyBaseName(k) === name);
  if (exact.length === 1) return { key: exact[0]! };
  if (exact.length > 1) {
    return {
      key: null,
      error: `"${name}" matches ${exact.length} properties; pass the full name with its # suffix.`,
      candidates: exact,
    };
  }

  const lower = name.trim().toLowerCase();
  const ci = keys.filter((k) => propertyBaseName(k).toLowerCase() === lower);
  if (ci.length === 1) return { key: ci[0]! };
  if (ci.length > 1) {
    return {
      key: null,
      error: `"${name}" matches ${ci.length} properties case-insensitively; pass the full name with its # suffix.`,
      candidates: ci,
    };
  }

  return {
    key: null,
    error: `No component property named "${name}" on this instance.`,
    candidates: keys,
  };
}

/** Is this a VariableAlias object (a token bound to a property)? */
export function isPropVariableAlias(v: unknown): v is PropVariableAlias {
  return (
    !!v &&
    typeof v === "object" &&
    (v as { type?: unknown }).type === "VARIABLE_ALIAS" &&
    typeof (v as { id?: unknown }).id === "string"
  );
}

export interface PropertyValueResult {
  value?: PropertyValue;
  error?: string;
}

/**
 * Coerce a caller-written value to what setProperties() wants for `type`.
 * "true"/"false" become booleans (JSON round-trips lose the type often enough),
 * numbers become strings for TEXT/VARIANT. Anything else is an error, not a
 * best-effort guess.
 */
export function coercePropertyValue(
  type: string | undefined,
  raw: unknown,
): PropertyValueResult {
  if (isPropVariableAlias(raw)) return { value: raw };
  const t = (type ?? "").toUpperCase();

  if (t === "BOOLEAN") {
    if (typeof raw === "boolean") return { value: raw };
    if (raw === "true") return { value: true };
    if (raw === "false") return { value: false };
    return {
      error: `BOOLEAN property expects true/false (got ${JSON.stringify(raw)}).`,
    };
  }

  if (t === "TEXT" || t === "VARIANT") {
    if (typeof raw === "string") return { value: raw };
    if (typeof raw === "number") return { value: String(raw) };
    if (t === "VARIANT" && typeof raw === "boolean") return { value: String(raw) };
    return {
      error: `${t} property expects a string (got ${JSON.stringify(raw)}).`,
    };
  }

  if (t === "INSTANCE_SWAP") {
    if (typeof raw === "string" && raw.length > 0) return { value: raw };
    return {
      error: `INSTANCE_SWAP property expects a component id or key string (got ${JSON.stringify(raw)}).`,
    };
  }

  // Unknown/absent type (SLOT, or a stale read): accept the primitives Figma
  // accepts and let setProperties be the judge.
  if (typeof raw === "string" || typeof raw === "boolean") return { value: raw };
  return { error: `Unsupported value ${JSON.stringify(raw)} for property type "${type ?? "?"}".` };
}

/** One name→value pair already resolved against the live property map. */
export interface ResolvedProperty {
  /** The name the caller wrote. */
  name: string;
  key: string;
  type: string;
  value: PropertyValue;
}

export interface PropertyPlan {
  /** VARIANT props — must be applied first, in their own setProperties call. */
  variants: ResolvedProperty[];
  /** Everything else (BOOLEAN / TEXT / INSTANCE_SWAP). */
  rest: ResolvedProperty[];
  /** Names that could not be resolved or coerced, with the reason. */
  failed: Array<{ name: string; error: string; candidates?: string[] }>;
}

/**
 * Resolve a whole {name: value} patch against an instance's live property map,
 * splitting VARIANT props out from the rest.
 *
 * The split is not cosmetic: switching a variant re-reads the instance from a
 * different main component and drops property values set in the SAME
 * setProperties call. Applying variants first, then re-resolving and applying
 * the rest, is what makes `instantiate(set, {props})` keep its overrides.
 */
export function planPropertyPatch(
  available: Record<string, ComponentPropertyEntry>,
  input: Record<string, unknown>,
): PropertyPlan {
  const plan: PropertyPlan = { variants: [], rest: [], failed: [] };
  for (const [name, raw] of Object.entries(input)) {
    const match = resolvePropertyKey(available, name);
    if (!match.key) {
      plan.failed.push({
        name,
        error: match.error ?? "unresolved",
        ...(match.candidates ? { candidates: match.candidates } : {}),
      });
      continue;
    }
    const type = String(available[match.key]?.type ?? "");
    const coerced = coercePropertyValue(type, raw);
    if (coerced.value === undefined) {
      plan.failed.push({ name, error: coerced.error ?? "uncoercible" });
      continue;
    }
    const entry: ResolvedProperty = {
      name,
      key: match.key,
      type: type || "UNKNOWN",
      value: coerced.value,
    };
    if (entry.type === "VARIANT") plan.variants.push(entry);
    else plan.rest.push(entry);
  }
  return plan;
}

/**
 * Did a written value survive the read-back? Compared loosely because Figma
 * normalises (numbers→strings); a VariableAlias resolves to its value, so those
 * are never compared.
 */
export function propertyValueStuck(
  written: PropertyValue,
  readBack: unknown,
): boolean {
  if (isPropVariableAlias(written)) return true;
  if (typeof written === "boolean") return readBack === written;
  return String(readBack) === String(written);
}
