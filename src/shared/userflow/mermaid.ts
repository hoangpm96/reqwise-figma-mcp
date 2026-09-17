/**
 * Minimal mermaid `flowchart` parser — the convenience door for agents whose
 * business analysis is already written as mermaid. It understands only what a
 * userflow needs; anything else is reported, never silently dropped.
 *
 * Supported: node shapes [box] {decision} ([terminal]) [[external]] ((circle)),
 * inline `:::class`, `class a,b happy`, edges `-->` `-.->` `==>` with optional
 * `|"label"|`, edge chains (`a --> b --> c`), and inline node declarations
 * inside an edge statement. `classDef`, `style`, `linkStyle` and directives are
 * ignored (the palette comes from the class NAME, not from the mermaid colours).
 */
import type { FlowClass, FlowEdgeSpec, FlowKind, FlowNodeSpec } from "./types.js";

export interface ParsedMermaid {
  nodes: FlowNodeSpec[];
  edges: FlowEdgeSpec[];
  rankdir?: "TB" | "LR";
  warnings: string[];
}

const CONNECTOR = /(-\.-+>|-{2,}>|={2,}>)[ \t]*(?:\|[ \t]*("?)(.*?)\2[ \t]*\|)?/;

const SHAPE_KIND: Array<[RegExp, FlowKind]> = [
  [/^\{\{([\s\S]*)\}\}$/, "decision"],
  [/^\{([\s\S]*)\}$/, "decision"],
  [/^\(\[([\s\S]*)\]\)$/, "terminal"],
  [/^\(\(([\s\S]*)\)\)$/, "terminal"],
  [/^\[\[([\s\S]*)\]\]$/, "external"],
  [/^\[\(([\s\S]*)\)\]$/, "external"],
  [/^\[([\s\S]*)\]$/, "screen"],
  [/^\(([\s\S]*)\)$/, "state"],
  [/^>([\s\S]*)\]$/, "external"],
];

const KNOWN_CLASSES: FlowClass[] = ["happy", "error", "edge", "plain", "decision"];

export function parseMermaid(source: string): ParsedMermaid {
  const nodes = new Map<string, FlowNodeSpec>();
  const edges: FlowEdgeSpec[] = [];
  const classOf = new Map<string, FlowClass>();
  const warnings: string[] = [];
  let rankdir: "TB" | "LR" | undefined;

  const lines = source.split("\n");
  for (const raw of lines) {
    const line = stripComment(raw).trim();
    if (!line) continue;

    const header = line.match(/^(?:flowchart|graph)\s+(TB|TD|LR|RL|BT)\b/i);
    if (header) {
      const dir = (header[1] ?? "TB").toUpperCase();
      rankdir = dir === "LR" || dir === "RL" ? "LR" : "TB";
      continue;
    }
    if (/^(classDef|style|linkStyle|click|%%|subgraph|end\b|direction)\b/i.test(line)) {
      if (/^subgraph\b/i.test(line)) {
        warnings.push(
          `mermaid: subgraph "${line.slice(9).trim()}" ignored — draw each subgraph as its own userflow call.`,
        );
      }
      continue;
    }

    // Same id charset as parseNodeRef — with `\w` only, `class a.b happy` fell
    // through and was parsed as a NODE called "class".
    const cls = line.match(/^class\s+([A-Za-z0-9_.,\s-]+?)\s+(\w+)\s*$/);
    // `class` followed by whitespace or nothing is the keyword; `class["X"]`
    // is still a node whose id happens to be "class".
    if (!cls && /^class(\s|$)/i.test(line)) {
      warnings.push(
        `mermaid: could not read the class statement "${line}" — expected \`class id1,id2 className\`. Skipped.`,
      );
      continue;
    }
    if (cls) {
      for (const id of (cls[1] ?? "").split(",")) {
        const name = id.trim();
        if (name) classOf.set(name, normalizeClass(cls[2] ?? "", warnings));
      }
      continue;
    }

    if (CONNECTOR.test(line)) {
      parseEdgeLine(line, nodes, edges, warnings);
      continue;
    }

    const decl = parseNodeRef(line, warnings);
    if (decl) {
      mergeNode(nodes, decl);
      continue;
    }
    warnings.push(`mermaid: line not understood, skipped — ${line}`);
  }

  for (const [id, cls] of classOf) {
    const n = nodes.get(id);
    if (n) n.cls = cls;
    else warnings.push(`mermaid: class applied to unknown node "${id}".`);
  }

  return { nodes: [...nodes.values()], edges, ...(rankdir ? { rankdir } : {}), warnings };
}

function stripComment(line: string): string {
  const i = line.indexOf("%%");
  return i >= 0 ? line.slice(0, i) : line;
}

function parseEdgeLine(
  line: string,
  nodes: Map<string, FlowNodeSpec>,
  edges: FlowEdgeSpec[],
  warnings: string[],
): void {
  // Walk the chain left to right: ref (connector ref)+. The label and dash
  // style captured by a connector belong to the edge that CLOSES on the next
  // node, so they are carried forward one step.
  const scan = new RegExp(CONNECTOR.source, "g");
  let cursor = 0;
  let prevId: string | null = null;
  let label = "";
  let kind: "forward" | "return" = "forward";
  let m: RegExpExecArray | null;
  while ((m = scan.exec(line)) !== null) {
    const head = line.slice(cursor, m.index).trim();
    const node = parseNodeRef(head, warnings);
    if (!node) {
      warnings.push(`mermaid: cannot read node "${head}" in — ${line}`);
      return;
    }
    mergeNode(nodes, node);
    if (prevId) edges.push(makeEdge(prevId, node.id, label, kind));
    prevId = node.id;
    label = m[3] ?? "";
    kind = (m[1] ?? "").startsWith("-.") ? "return" : "forward";
    cursor = m.index + m[0].length;
  }
  const tailText = line.slice(cursor).trim();
  const tail = parseNodeRef(tailText, warnings);
  if (!tail) {
    warnings.push(`mermaid: cannot read node "${tailText}" in — ${line}`);
    return;
  }
  mergeNode(nodes, tail);
  if (prevId) edges.push(makeEdge(prevId, tail.id, label, kind));
}

function makeEdge(
  from: string,
  to: string,
  label: string,
  kind: "forward" | "return",
): FlowEdgeSpec {
  const trimmed = label.trim().replace(/^"|"$/g, "");
  return { from, to, kind, ...(trimmed ? { label: trimmed } : {}) };
}

function parseNodeRef(text: string, warnings: string[]): FlowNodeSpec | null {
  if (!text) return null;
  let body = text;
  let cls: FlowClass | undefined;
  const clsMatch = body.match(/:::(\w+)\s*$/);
  if (clsMatch) {
    cls = normalizeClass(clsMatch[1] ?? "", warnings);
    body = body.slice(0, clsMatch.index).trim();
  }
  const idMatch = body.match(/^([A-Za-z0-9_.-]+)/);
  if (!idMatch || !idMatch[1]) return null;
  const id = idMatch[1];
  const shape = body.slice(id.length).trim();
  if (!shape) return { id, label: id, ...(cls ? { cls } : {}) };

  for (const [re, kind] of SHAPE_KIND) {
    const m = shape.match(re);
    if (!m) continue;
    const label = (m[1] ?? "").trim().replace(/^"|"$/g, "");
    return {
      id,
      label: label || id,
      kind,
      ...(cls ? { cls } : {}),
    };
  }
  warnings.push(`mermaid: unknown node shape for "${text}" — treated as a box.`);
  return { id, label: shape.replace(/^[[({<>]+|[\])}>]+$/g, "").trim() || id, ...(cls ? { cls } : {}) };
}

/** Later declarations win for the label/shape; an id-only mention never wipes one. */
function mergeNode(nodes: Map<string, FlowNodeSpec>, next: FlowNodeSpec): void {
  const prev = nodes.get(next.id);
  if (!prev) {
    nodes.set(next.id, next);
    return;
  }
  if (next.label !== next.id) prev.label = next.label;
  if (next.kind) prev.kind = next.kind;
  if (next.cls) prev.cls = next.cls;
}

function normalizeClass(name: string, warnings: string[]): FlowClass {
  const lower = name.toLowerCase() as FlowClass;
  if (KNOWN_CLASSES.includes(lower)) return lower;
  warnings.push(
    `mermaid: class "${name}" is not one of happy|error|edge|plain|decision — drawn as plain.`,
  );
  return "plain";
}
