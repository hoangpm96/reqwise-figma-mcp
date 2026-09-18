/// <reference types="@figma/plugin-typings" />
/**
 * The tags a drawn diagram leaves on its frame. Each kind gets its own key,
 * because they mean different things to the rest of the tooling: a userflow
 * answers "has anybody mapped the screens?" (which `create` asks before
 * drawing more of them), while an activity diagram answers "who does what",
 * and an activity diagram on the page is NOT a mapped userflow.
 */
export const ACTIVITY_MARKER = "reqwise.activity";
export const ERD_MARKER = "reqwise.erd";
export const SEQUENCE_MARKER = "reqwise.sequence";
export const STATE_MARKER = "reqwise.state";
export const USECASE_MARKER = "reqwise.usecase";
export const JOURNEY_MARKER = "reqwise.journey";
export const SITEMAP_MARKER = "reqwise.sitemap";
export const PERSONA_MARKER = "reqwise.persona";
export const BPMN_MARKER = "reqwise.bpmn";

/**
 * Every key a diagram tool has ever written on a frame, in ONE list.
 *
 * Three places need to ask "is this a frame a diagram tool drew?" —
 * `readDiagramSource` (so a frame can be read back and patched),
 * `reflow_diagram` (so it can be pointed at a frame) and the live watcher.
 * Each of them used to carry its own copy of the list, and each copy went
 * stale on its own schedule: the read-back list once said "reqwise.flow"
 * against a marker called "reqwise.userflow", so no userflow frame could be
 * patched; the reflow op's copy named two markers out of seven, so an ERD,
 * sequence, state, use case or journey frame was refused as "not a frame
 * drawn by a diagram tool". Both symptoms pointed away from the cause.
 *
 * So: the constants, once, and everybody asks here.
 */
export const DIAGRAM_MARKERS = [
  ACTIVITY_MARKER,
  BPMN_MARKER,
  ERD_MARKER,
  JOURNEY_MARKER,
  PERSONA_MARKER,
  SEQUENCE_MARKER,
  SITEMAP_MARKER,
  STATE_MARKER,
  USECASE_MARKER,
  // The userflow keys live in flow-mark.ts, which owns the flow lookup; they
  // are spelled out here rather than imported to keep this module free of
  // dependencies, and `marker-list.test.ts` asserts the two agree.
  "reqwise.userflow",
  "reqwise.flowchart",
] as const;

/** Does this node carry any diagram tool's marker, graph or no graph? */
export function hasDiagramMarker(node: BaseNode): boolean {
  for (const key of DIAGRAM_MARKERS) {
    let raw = "";
    try {
      raw = node.getPluginData(key);
    } catch {
      continue;
    }
    if (raw) return true;
  }
  return false;
}

/** Read a marker payload, or null when the node carries none. */
export function readDiagramData(node: BaseNode, key: string): Record<string, unknown> | null {
  let raw = "";
  try {
    raw = node.getPluginData(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    // Unreadable marker data still means "a diagram lives here".
    return {};
  }
}

/**
 * Layer names the diagram tools generate. A drawn diagram deliberately puts
 * unlike shapes side by side — a 20px start pill next to a 10px action box, a
 * diamond next to a bar — so the "similar siblings should share a radius"
 * style hint is a false positive on them, and an agent that "fixes" it breaks
 * the notation. Findings that are about REAL problems (contrast, clipping,
 * truncation) still apply.
 */
/** The frame a diagram tool draws, by the name each one gives its frame. */
export function isDiagramFrameName(name: string): boolean {
  // The full "<Kind> · " prefix, not the bare word: a frame the user named
  // "State machine" or "Activity log" is theirs, and skipping it would hide
  // real findings on a real screen.
  for (const kind of ["Userflow", "Activity", "BPMN", "ERD", "Sequence", "State", "Use case", "Journey", "Sitemap", "Persona"]) {
    if (name.indexOf(`${kind} \u00b7 `) === 0) return true;
  }
  return false;
}

export function isDiagramLayerName(name: string): boolean {
  for (const prefix of [
    "step:",
    "flow:",
    "bpmn:",
    "pool:",
    "pool-head:",
    "pool-name:",
    "lane-name:",
    "glyph:",
    "mark:",
    "ring:",
    "fold:",
    "rim:",
    "lane:",
    "lane-head:",
    "text:",
    "entity:",
    "party:",
    "state:",
    "page:",
    "ring:",
    "actor:",
    "uc:",
    "phase:",
    "persona:",
    "rail:",
    "avatar:",
    "tagline:",
    "facts:",
    "quote:",
    "quote-rule:",
    "scale:",
    "dots:",
    "app:",
    "apps-label:",
    "scales-label:",
    "section:",
    "section-label:",
    "section-body:",
    "source:",
    "source-box:",
    "primary:",
    "column:",
    "cell:",
    "row-head:",
    "meta:",
    "curve",
    "head:",
    "boundary",
    "life ",
    "bar ",
    "frag ",
    "frag-tab ",
    "frag-else ",
    "frag-else-label ",
    "note ",
    "row ",
    "edge ",
    "arrow ",
    "mark ",
    "mark-o ",
    "label ",
    "q ",
  ]) {
    if (name.indexOf(prefix) === 0) return true;
  }
  return false;
}
