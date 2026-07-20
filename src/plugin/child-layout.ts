/// <reference types="@figma/plugin-typings" />

/**
 * Child-in-auto-layout property application (`layoutAlign`, `layoutGrow`),
 * shared by the create and modify handlers so the two never drift.
 *
 * Beyond plain assignment it fixes the Figma quirk where a stretch/grow is
 * silently overridden by the child's own hug sizing: an auto-layout frame with
 * `primaryAxisSizingMode:"AUTO"` on the stretched axis ignores
 * `layoutAlign:"STRETCH"` and keeps hugging its content — the reason
 * buttons/inputs render hug-width even though STRETCH was applied. When that
 * combination is detected the stretched axis is forced to FIXED (unless the
 * caller explicitly asked for a sizing mode on that axis).
 *
 * Duck-typed on plain objects so it is unit-testable outside Figma.
 */

type Axis = "horizontal" | "vertical";
type Warn = (msg: string) => void;

interface LayoutLike {
  layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL";
  layoutAlign?: string;
  layoutGrow?: number;
  primaryAxisSizingMode?: "FIXED" | "AUTO";
  counterAxisSizingMode?: "FIXED" | "AUTO";
  parent?: unknown;
}

export function applyChildLayoutProps(
  node: object,
  props: Record<string, unknown>,
  parent: object | null | undefined,
  warn?: Warn,
): void {
  const n = node as LayoutLike;
  if ("layoutAlign" in node && typeof props.layoutAlign === "string") {
    n.layoutAlign = props.layoutAlign;
    if (props.layoutAlign === "STRETCH") {
      const axis = crossAxisOf(parent);
      if (axis) forceFixedSizing(n, axis, props, warn);
    }
  }
  if ("layoutGrow" in node && typeof props.layoutGrow === "number") {
    n.layoutGrow = props.layoutGrow;
    if (props.layoutGrow > 0) {
      const axis = primaryAxisOf(parent);
      if (axis) forceFixedSizing(n, axis, props, warn);
    }
  }
}

function crossAxisOf(parent: object | null | undefined): Axis | null {
  const mode = layoutModeOf(parent);
  if (mode === "VERTICAL") return "horizontal";
  if (mode === "HORIZONTAL") return "vertical";
  return null;
}

function primaryAxisOf(parent: object | null | undefined): Axis | null {
  const mode = layoutModeOf(parent);
  if (mode === "VERTICAL") return "vertical";
  if (mode === "HORIZONTAL") return "horizontal";
  return null;
}

function layoutModeOf(parent: object | null | undefined): string | null {
  if (!parent || !("layoutMode" in parent)) return null;
  return String((parent as LayoutLike).layoutMode);
}

/**
 * Force the sizing mode of `axis` on an auto-layout frame to FIXED so a
 * stretch/grow along that axis is honoured instead of being overridden by
 * hug-contents. No-op when the node is not an auto-layout frame, or when the
 * caller explicitly passed a sizing mode for that axis (their choice wins).
 */
function forceFixedSizing(
  n: LayoutLike,
  axis: Axis,
  props: Record<string, unknown>,
  warn?: Warn,
): void {
  if (!n.layoutMode || n.layoutMode === "NONE") return;
  const prop =
    (n.layoutMode === "HORIZONTAL") === (axis === "horizontal")
      ? "primaryAxisSizingMode"
      : "counterAxisSizingMode";
  if (typeof props[prop] === "string") return;
  if (n[prop] !== "FIXED") {
    n[prop] = "FIXED";
    warn?.(
      `layoutAlign:"STRETCH"/layoutGrow on an auto-layout frame with hug sizing on the stretched axis: ${prop} set to FIXED so the stretch takes effect. Pass ${prop} explicitly to override.`,
    );
  }
}
