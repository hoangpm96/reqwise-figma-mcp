/**
 * Reqwise Figma MCP server entry point.
 *
 * - Speaks MCP over stdio (@modelcontextprotocol/sdk low-level Server, so we
 *   own the exact JSON schemas and the {code,message,hint} error shape).
 * - Registers the tools: figma_status, figma_read, figma_write, figma_diagram,
 *   figma_rules, figma_docs.
 *   A userflow is figma_diagram type:"userflow".
 * - Elects leader/follower via the Coordinator. Every operation — a direct
 *   tool call on the leader, a figma.* call from the vm executor, or a
 *   follower forward arriving on /rpc — funnels through `runValidated()`, the
 *   single validateOperation choke point.
 */
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "./version.js";
import { ErrorCode, OpError, toBridgeError } from "./errors.js";
import { validateOperation } from "./validate.js";
import { isProFeature, proFeatureMessage } from "../shared/editions.js";
import { SessionRegistry } from "./session.js";
import { Coordinator } from "./leader.js";
import { Follower, STATUS_RPC_TIMEOUT_MS } from "./follower.js";
import { executeWrite, type WriteResult } from "./executor.js";
import { isDirectRun } from "./is-main.js";
import { installShutdown } from "./shutdown.js";
import {
  handleDocs,
  handleDiagram,
  handleRead,
  handleRules,
  handleStatus,
  handleWrite,
  type Diagnostics,
  type ToolContext,
} from "./tools.js";
import type { Bridge } from "./bridge.js";
import type { AnyOperation, BridgeResponse } from "../shared/protocol.js";
import { DOC_SECTION_NAMES } from "./docs-content/index.js";
import { READ_OPERATIONS, DEFAULT_PORT, PORT_RANGE } from "../shared/protocol.js";
import { parseRouteArg, type RouteArg } from "./route.js";

// ---- JSON tool schemas (match ARCHITECTURE.md) ----

/** Exported so a test can hold the advertised surface to what actually exists. */
/**
 * A shallow array property: the field list lives in one line of prose instead
 * of a nested JSON Schema tree.
 *
 * Every byte of every tool definition is paid for in EVERY session, whether or
 * not a diagram gets drawn, and the five per-type field trees were 14KB of it.
 * The exact shape is still enforced — by the zod schemas in validate.ts, which
 * answer a wrong call with INVALID_PARAMS and a hint — and figma_docs carries
 * the full tables. Same trade the tool already makes for figma_write's `code`.
 */
const arrayOf = (description: string) => ({
  type: "array" as const,
  description,
  items: { type: "object" as const, additionalProperties: true },
});

/** Shared by every canvas tool so agents route by file/page, not channel ids. */
const ROUTE_TARGET = {
  file: {
    type: "string" as const,
    description:
      'File name, fuzzy ("klopop"). Session remembers it. Different files run in parallel.',
  },
  page: {
    type: "string" as const,
    description: 'Page name, fuzzy ("ui"). Pins to that window or switches. Same page queues.',
  },
  channel: {
    type: "string" as const,
    description: "Window id. Optional — prefer file/page, or omit to follow this session's last target / the focused window.",
  },
};

export const TOOLS: Tool[] = [
  {
    name: "figma_status",
    description:
      "Rich connection diagnostics for the Figma bridge (never a bare boolean): plugin connection, leader/follower mode, port, heartbeat, queue, sessions, and an ordered list of concrete next-step hints when something is off. `pluginConnected` is TRI-STATE: true/false are measured, null means UNKNOWN (this follower could not query the leader — see `statusSource`/`statusError`). Do NOT treat null as disconnected and do NOT ask the user to reopen the plugin on that basis; ops may still be forwarding fine. `channels[]` lists file, page, focused — pass those as file/page on later tools; this session stickies. Different files run in parallel.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "figma_read",
    description:
      "Read the Figma canvas with a token-frugal response. Choose an operation and pass its params. layout_audit is the structured verify tool: blocking issues cover bounds/clipping/truncation, while styleHints flag tight padding, inconsistent radius and low contrast. read_selection deep-reads the current selection in one call — the entry point of the selection-first edit-in-place lifecycle (read_selection → figma_write modify → layout_audit).",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: [...READ_OPERATIONS, "list_channels"],
          description: "The read operation to run. list_channels lists connected Figma windows (file, page, focused) — pass those names as file/page on later tools; channel ids are optional.",
        },
        params: {
          type: "object",
          description: "Operation parameters (e.g. { nodeId }, { nodeIds }, { detail: 'sparse'|'compact'|'full' }, read_selection: { detail?, depth? }).",
          additionalProperties: true,
        },
        ...ROUTE_TARGET,
      },
      required: ["op"],
      additionalProperties: false,
    },
  },
  {
    name: "figma_write",
    description:
      "Execute modern-ES JavaScript in a sandbox against the figma.* proxy to draw/modify the canvas. NOT the official Figma Plugin API — read figma_docs(section=\"api\") before first use. Key rules: FRAME/COMPONENT without fill/fills is transparent (structural wrapper); visible cards/controls need an explicit fill, design-system radius and 12–24px padding. create() takes ONE spec object with parentId INSIDE it (omitting parentId drops the node at page level). Colors are \"#rrggbb\" or {r,g,b} 0..1. `state` persists across calls. Drawing SCREENS? Ask the user first whether to map the userflow (figma_diagram type:\"userflow\") — create() warns you when the page has no flow, or has one the new screen is missing from. Banned: require/process/fetch/timers/eval. Returns { ok, result, logs, warnings }.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "JavaScript body. Use await figma.create({...}), figma.batch([...]), figma.layoutAudit(id), etc. Return a value to receive it as `result`.",
        },
        sessionId: {
          type: "string",
          description: "Optional session key. Omit for this MCP connection's own private session (each Claude Code / Codex instance gets isolated `state` automatically). Pass an explicit shared key only to deliberately share state across agents.",
        },
        ...ROUTE_TARGET,
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "figma_diagram",
    description:
      "Draw a UML/BA diagram that is not a userflow, from a model YOU derived — the tool lays it out, draws it, and proof-reads the model. Pick `type` by the question it answers — its own description lists all six. Read figma_docs(section=\"activity\"|\"erd\"|\"sequence\"|\"sitemap\"|\"state\"|\"userflow\") for the field tables and the notation traps; the /figma-* skills carry the interview and the DO/DON'T tables. `warnings` are findings about the MODEL, not the drawing — an unlabelled handoff, a table with no primary key, a call nobody answers, a state nothing can leave — and they are the deliverable: act on each one, never fill a field to silence one. Compare `stats` with what you sent: anything a diagram of that kind cannot mean is DROPPED. One call does the lot: options.checkFirst proof-reads and draws only if clean, `audit` (render-side: overflow/clipping/truncation) comes back with the draw, and `diagrams: [...]` draws and places a whole set. For type:\"activity\", ASK the user LR (horizontal lanes) or TB before drawing. Arrows follow their boxes: dragging a shape re-routes live, dragging an arrow's END reconnects it, and figma.reflowDiagram() fixes one rearranged with the plugin closed.",
    inputSchema: {
      type: "object",
      properties: {
        diagrams: {
          type: "array",
          description: "Draw a SET in one call: one entry per diagram, each with its own type/title/content. The frames are PLACED for you (see `place`), so you never compute x/y from the previous box. Findings come back per entry, prefixed with its title. An entry may carry its own `update` (and `patch`) to redraw a frame that already exists: it keeps its id and its position, and does not take a slot in the placement — which is how you re-run a set without ending up with every diagram on the page twice.",
          items: { type: "object", additionalProperties: true },
        },
        place: {
          type: "string",
          enum: ["column", "row", "none"],
          description: "Batch layout: \"column\" (default) stacks the frames downwards from x/y, \"row\" lays them rightwards, \"none\" leaves every entry at its own x/y. An explicit x/y on an entry always wins.",
        },
        gap: { type: "number", description: "Gap between batched frames in px (default 250)." },
        type: {
          type: "string",
          enum: ["activity", "erd", "sequence", "sitemap", "state", "userflow"],
          description: "Which diagram to draw. activity = a business process (with or without swimlanes); erd = a data model of tables, columns and the keys that join them; sequence = the exchange between systems over time; sitemap = the product's PAGES and which page contains which — containment, NOT navigation; state = the lifecycle of ONE entity, the values it can hold and what moves it between them; userflow = the screens a user moves through, which alone takes `mermaid` rather than `text`.",
        },
        title: { type: "string", description: "Heading drawn on the frame, e.g. \"Purchase order approval\"." },
        subtitle: { type: "string", description: "Optional one-line context under the title." },
        text: {
          type: "string",
          description: "The COMPACT form — pass this INSTEAD of the arrays, at roughly a third of the tokens. One line per thing, `#` comments, and the ids that exist only to be referenced are generated for you. sequence: `actor u \"User\"` then `u ->> api: POST /pay` (`-->>` reply, `--)` async) with `alt … else … end` / `loop … end` written where they apply. activity: `lane sys \"System\"` then `sys: pay ? \"Paid?\"` and `a > b \"label\"` (`~>` rework). erd: a table then its indented columns `id uuid pk!`, and `users.id 1-* bookings.user_id \"books\"`. state: `paid \"Paid\" final ok` and `held -> paying: Event [guard] / action`. usecase: `system \"…\"`, `uc book \"Book seats\"`, then `visitor - book` / `book => hold` / `login +> book` / `member :> visitor`. journey: `phase pay \"Thanh toán\"` then `do`/`at`/`think`/`feel`/`pain`/`fix`. persona: `source \"4 phỏng vấn\"`, then `persona tu \"Tên\" primary` and `tag`/`fact`/`quote`/`bio`/`behav`/`goal`/`pain`/`need`/`want`/`level \"X\" 4`/`app`. sitemap: `crm \"CRM\"`, children INDENTED under their parent; `screen:<artboardId>`, `/ detail`. FULL grammar per kind: figma_docs({ section, level: \"cheat\" }) — read it once before your first one. Any line it cannot read is REPORTED, never dropped. NOT for type:\"userflow\", which takes `mermaid`.",
        },
        mermaid: {
          type: "string",
          description: "type:\"userflow\" ONLY — a mermaid `flowchart TD` source, used INSTEAD of nodes+edges. Every other kind uses `text`, a different grammar; passing `text` to a userflow is an error it cannot diagnose.",
        },
        parentId: { type: "string", description: "Parent frame/section id. Omitted → the frame lands on the current page." },
        x: { type: "number", description: "Frame x on the page (default 0). Place blocks yourself so they don't stack." },
        y: { type: "number", description: "Frame y on the page (default 0)." },
        update: {
          type: "string",
          description: "Redraw THIS frame (the `frameId` a diagram tool returned) instead of making a new one. It keeps its id, so comments on it, prototype links into it and wherever the user dragged it all survive. With `patch` the spec is not needed at all; without one, the spec in this call replaces what the frame holds.",
        },
        patch: arrayOf(
          "Change the model the frame already stores — needs `update`, and NOTHING else of the model, because the frame is the source. Each op: { collection, id|where|at, set:{…} } | { collection, add:{…}, after? } | { collection, remove: id }. `collection` is any array of the kind (messages, entities, transitions, links, nodes, edges, …); omit it to set a field on the diagram itself (title, system, …). Select by `id`, or by `where:{from,to}` for the collections that have none, or `at:<index>`. Applied in order, then checked like any other spec. Read what is there first with figma_read op:\"get_diagram_spec\".",
        ),
        participants: arrayOf(
          "sequence — the columns, left to right. id, name, detail?, kind?(actor|system|external|queue|db), cls?",
        ),
        messages: arrayOf(
          "sequence — the arrows, IN TIME ORDER: the array IS the diagram. id, from, to, label (say WHAT is sent), kind?(sync default, opens an activation bar|async|return, which CLOSES it), note?, cls?. from===to is a self-message",
        ),
        fragments: arrayOf(
          "sequence — alt/opt/loop/par/break around a CONTIGUOUS run. kind, label, messages[] (ids), else?{label,messages[]}",
        ),
        entities: arrayOf(
          "erd — the tables. id, name, detail?, cls?(happy|edge|error), external?, attributes[]{name,type?,key?(pk|fk|pfk),required?}",
        ),
        relations: arrayOf(
          "erd — what joins to what. from, to, fromField/toField (NAME THE COLUMNS), fromCard?/toCard?(one|many|zero-one|zero-many|one-many), label?, identifying?, fromSide?/toSide?. Many-to-many is not storable: add the join table",
        ),
        pages: arrayOf(
          "sitemap — the pages. id, label, parent (the page that CONTAINS it, never the page you came FROM; omit on the root), kind?(page|section: a nav heading with no page of its own|modal|external), detail?, screenId? (ONE artboard id, or a LIST: the page plus its states — a list page and its empty state are one page), cls?. There is NO edges array: the tree is the parents",
        ),
        states: arrayOf(
          "state — every value the ONE entity can hold. id (the value the SYSTEM stores), label?, kind?(initial: exactly one|final|choice|fork|join), entry?/do?/exit?, detail?, cls?",
        ),
        transitions: arrayOf(
          "state — every change allowed, as `event [guard] / action`. from, to, event?, guard? (two transitions on one event NEED guards), action?, kind?(return for a way back), cls?, fromSide?/toSide?/fromAt?/toAt?",
        ),
        lanes: arrayOf(
          "activity — one band per OWNER (a role/team/system that DOES something, never a system layer). id, label, detail?. Omit for a plain activity diagram",
        ),
        nodes: arrayOf(
          "activity — the steps: id, label, lane (REQUIRED once the diagram has lanes; a step nobody owns is reported), kind?(action|decision needs >=2 labelled branches|start|end|fork|join|event|external), cls?. userflow — the screens: id, label, detail?, kind?(screen|decision|terminal|external|state), cls?, screenId?, slug?",
        ),
        edges: arrayOf(
          "activity/userflow — from, to, label (on a lane crossing say WHAT is handed over; an unlabelled handoff is reported), event? (userflow: what CAUSES it), kind?(return: dashed, routed outside), fromSide?/toSide?/fromAt?/toAt?",
        ),
        options: {
          type: "object",
          properties: {
            rankdir: { type: "string", enum: ["TB", "LR"], description: "LR (default) runs a process left→right with horizontal lanes; TB downwards. For state/userflow it is simply which way it reads (userflow defaults TB)." },
            font: { type: "string", description: "Font for every label. Default Inter, which has NO CJK/Hangul glyphs — a Vietnamese diagram is fine, a Japanese or Korean one renders BLANK without e.g. \"Noto Sans KR\". Check with figma_read get_fonts." },
            colorByTarget: { type: "boolean", description: "Colour each arrow by the class of what it points at (default true)." },
            liveRoute: { type: "boolean", description: "Keep arrows attached when a shape is dragged (default true)." },
            linkScreens: { type: "boolean", description: "type:\"userflow\" — wire ON_CLICK → NAVIGATE from each screen box to the artboard whose name contains its screenId. Unmatched ids are reported, never guessed." },
            dryRun: { type: "boolean", description: "Check and return findings + size WITHOUT drawing. It never reaches the plugin, so it proves nothing about the write path — use figma_status." },
            checkFirst: { type: "boolean", description: "Check, and draw ONLY if there are no findings. Dirty → `checkedOnly: true` + the findings, nothing drawn. All-or-nothing across a `diagrams` batch." },
            layout: { type: "string", enum: ["tree", "dagre"], description: "type:\"sitemap\" — tree (default, keeps the nav order you wrote) or dagre." },
            maxDepth: { type: "number", description: "type:\"sitemap\" — levels allowed before depth is reported, root = 1 (default 4, i.e. three clicks in)." },
            verify: { type: "boolean", description: "Return layout_audit of the frame just drawn as `audit` (default TRUE — it costs no round trip)." },
            policies: {
              type: ["object", "null"],
              description: "Rules that have a VALUE: { \"hold-minutes\": 10, \"retry-attempts\": 3 }. Reference one from any label as `@hold-minutes` and it is filled in when drawn — \"Giữ ghế @hold-minutes phút\" draws \"Giữ ghế 10 phút\". Two diagrams then cannot quote one rule differently. The reference survives into the stored model, so get_page_model can say which frames depend on a rule. Beside a patch, rules MERGE: a rule set to null is removed, policies:null removes all.",
              additionalProperties: { type: ["string", "number", "null"] },
            },
            crossCheck: { type: "boolean", description: "Compare the drawing against the other diagrams on its page and return contradictions as `consistency`; a sitemap also gets `coverage` — pages with no artboard yet, artboards belonging to no page (default TRUE; costs no round trip)." },
          },
          additionalProperties: false,
        },
        channel: ROUTE_TARGET.channel,
        file: ROUTE_TARGET.file,
        page: ROUTE_TARGET.page,
      },
      // One diagram needs type+title; a `diagrams` batch carries them per entry,
      // so the pair is checked in the handler, with a hint instead of a schema error.
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "figma_rules",
    description:
      "One-call design-system rule sheet as markdown: styles + variables + components, fetched in parallel. Read before drawing so you reuse tokens/components instead of hardcoding.",
    inputSchema: {
      type: "object",
      properties: {
        channel: ROUTE_TARGET.channel,
        file: ROUTE_TARGET.file,
        page: ROUTE_TARGET.page,
      },
      additionalProperties: false,
    },
  },
  {
    name: "figma_docs",
    description:
      "On-demand documentation for this API and its safe-by-default rules. Sections: rules | layout | api | tokens | icons | recipes | style | userflow | activity | erd | sequence | sitemap | state. Read `style` when drawing a screen with NO design.md / no existing design system — it is the default type scale, spacing grid, color palette and elevation to fall back on instead of inventing values (which reads as generic/lifeless).",
    inputSchema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          enum: [...DOC_SECTION_NAMES],
          description: "Which doc section to return.",
        },
        level: {
          type: "string",
          enum: ["full", "cheat"],
          description: "\"cheat\" returns just the call shape and the field tables — a fraction of the tokens, enough to write the call. \"full\" (default) adds the findings this kind reports, the notation traps and the layout notes: read it when a warning needs explaining, or the first time you draw this kind.",
        },
      },
      required: ["section"],
      additionalProperties: false,
    },
  },
];

// ---- port configuration ----

/**
 * Resolve the bridge start port from FIGMA_MCP_PORT.
 *
 * This env var was referenced in an error hint ("Set FIGMA_MCP_PORT to a free
 * port") long before anything read it — following that advice did nothing.
 * It is honoured here, with two guards, because the plugin cannot be
 * configured to match:
 *
 *   - A malformed/out-of-range value is REJECTED loudly rather than silently
 *     falling back, so a typo can't look like it worked.
 *   - plugin/ui.html scans a hardcoded DEFAULT_PORT..+PORT_RANGE-1 window. A
 *     port outside it binds fine but the plugin will never find the server, so
 *     we warn on stderr instead of leaving the user with a silent no-connect.
 */
export function resolveStartPort(
  env: NodeJS.ProcessEnv = process.env,
  warn: (msg: string) => void = (msg) => process.stderr.write(msg),
): number {
  const raw = env["FIGMA_MCP_PORT"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `FIGMA_MCP_PORT must be an integer between 1 and 65535 (got "${raw}").`,
    );
  }
  // Ports below 1024 need root on Unix; the bridge is loopback-only tooling.
  if (port < 1024) {
    throw new Error(
      `FIGMA_MCP_PORT=${port} is a privileged port (<1024). Use 1024–65535, ideally ${DEFAULT_PORT}.`,
    );
  }
  if (port < DEFAULT_PORT || port > DEFAULT_PORT + PORT_RANGE - 1) {
    warn(
      `[reqwise-figma-mcp] warning: FIGMA_MCP_PORT=${port} is outside the range the Figma plugin scans ` +
        `(${DEFAULT_PORT}-${DEFAULT_PORT + PORT_RANGE - 1}). The server will bind it, but the plugin cannot ` +
        `discover it and will never connect. Use a port in that range unless you are proxying.\n`,
    );
  }
  return port;
}

// ---- server assembly ----

export interface ServerHandle {
  server: Server;
  coordinator: Coordinator;
  /** Live status snapshot (exposed for tests + the figma_status tool path). */
  diagnostics: () => Promise<Diagnostics>;
  close: () => Promise<void>;
}

export async function createServer(): Promise<ServerHandle> {
  const sessions = new SessionRegistry();

  // Each server process serves exactly ONE MCP client (stdio). Give that
  // client its own default session so parallel Claude Code / Codex instances
  // never share mutable vm `state` by accident. An explicit sessionId still
  // opts into deliberate sharing across agents.
  const defaultSessionId = `s-${randomUUID().slice(0, 8)}`;
  const resolveSession = (sessionId?: string): string =>
    sessionId && sessionId.length > 0 ? sessionId : defaultSessionId;

  // ALWAYS read the bridge live from the coordinator — never capture it. A
  // follower that takes over leadership creates a NEW Bridge; a captured
  // local went stale and every op after the takeover died NOT_CONNECTED
  // while figma_status simultaneously misreported "follower" (real bug).
  const liveBridge = (): Bridge | undefined => coordinator.bridge;

  const coordinator: Coordinator = new Coordinator({
    startPort: resolveStartPort(),
    // THE single choke point. Called for leader-direct ops AND /rpc forwards —
    // wired by leader.ts onto EVERY bridge it creates, so the synthetic ops
    // below keep working across takeovers (no post-hoc router to forget).
    runValidated: async (op, params, sessionId, route) => {
      const hint = parseRouteArg(route);
      // Synthetic /rpc ops from followers (never sent to the plugin, so they
      // must be intercepted before validateOperation rejects them):
      // __register__ makes the follower's session visible in the plugin UI
      // picker; __write__ runs its figma_write on the leader's vm executor.
      if (op === "__register__") {
        if (sessionId) sessions.get(sessionId);
        return { registered: true };
      }
      // __status__ lets a follower read the leader's REAL plugin state instead
      // of guessing. Before this existed the follower reported a hardcoded
      // pluginConnected:false and sent users to restart a live plugin.
      if (op === "__status__") {
        const b = liveBridge();
        if (!b) throw new OpError(ErrorCode.NOT_CONNECTED, "Bridge unavailable on leader.", "Restart the leader.");
        return leaderPluginState(b);
      }
      if (op === "__write__") {
        const code = typeof params["code"] === "string" ? (params["code"] as string) : "";
        return executeWrite(code, sessions.get(sessionId), {
          runOp: async (subOp, subParams, ctx): Promise<BridgeResponse> => {
            const { op: v, params: p } = validateOperation(subOp, subParams);
            const b = liveBridge();
            if (!b) throw new OpError(ErrorCode.NOT_CONNECTED, "Bridge unavailable.", "Restart the leader.");
            if (v === "list_channels") {
              return { id: "server", ok: true, result: b.channelSummaries() };
            }
            return b.dispatch(v, p, {
              ...hint,
              ...(sessionId ? { sessionId } : {}),
              ...(ctx ? { signal: ctx.signal } : {}),
            });
          },
        });
      }
      const { op: validOp, params: validParams } = validateOperation(op, params);
      return dispatchLeader(validOp, validParams, sessionId, hint);
    },
    // Runs for the initial bridge AND any takeover replacement.
    onBridgeCreated: (bridge) => {
      // Feed agent-session summaries to the bridge so plugin UIs can render
      // the "which agent drives this window?" picker. Sessions idle for over
      // an hour are hidden: a dead MCP process leaves no disconnect signal,
      // so without this the picker fills up with ghosts across restarts.
      const PICKER_IDLE_MS = 60 * 60 * 1000;
      bridge.setSessionsProvider(() =>
        sessions
          .summaries()
          .filter((s) => s.lastUsedMs < PICKER_IDLE_MS)
          .map((s) => ({
            id: s.id,
            writeCount: s.writeCount,
            lastUsedMs: s.lastUsedMs,
          })),
      );
      // Make this (leader) process's own session visible in the picker even
      // before its first write.
      sessions.get(defaultSessionId);
    },
  });

  /**
   * Leader-side dispatch of an already-validated op. Unwraps BridgeResponse to
   * a plain result or throws an OpError. This is only reachable on the leader
   * (the coordinator only calls runValidated when it owns the bridge, and /rpc
   * only exists on the leader). Server ops (list_channels) are answered from
   * bridge state — they never round-trip to the plugin.
   */
  async function dispatchLeader(
    op: AnyOperation,
    params: Record<string, unknown>,
    sessionId?: string,
    route?: { channel?: string; file?: string; page?: string },
  ): Promise<unknown> {
    const bridge = liveBridge();
    if (!bridge) {
      throw new OpError(
        ErrorCode.NOT_CONNECTED,
        "No bridge on this process (it is a follower or not yet started).",
        "This should be unreachable; report as a bug.",
      );
    }
    if (op === "list_channels") {
      return bridge.channelSummaries();
    }
    const res: BridgeResponse = await bridge.dispatch(op, params, {
      ...parseRouteArg(route),
      ...(sessionId ? { sessionId } : {}),
    });
    return unwrap(res);
  }

  /** validate → (leader: dispatch | follower: forward). Used by tool handlers. */
  async function runValidated(
    op: string,
    params: Record<string, unknown>,
    sessionId?: string,
    route?: RouteArg,
  ): Promise<unknown> {
    const { op: validOp, params: validParams } = validateOperation(op, params);
    const sid = resolveSession(sessionId);
    const hint = parseRouteArg(route);
    if (coordinator.role === "leader") {
      return dispatchLeader(validOp, validParams, sid, hint);
    }
    // Follower: local validation already done; leader validates again on /rpc.
    return coordinator.forward(validOp, validParams, sid, hint.channel, undefined, {
      file: hint.file,
      page: hint.page,
    });
  }

  /** figma_write execution. On a follower, forward the whole code to the leader. */
  async function runWrite(code: string, sessionId?: string, route?: RouteArg): Promise<WriteResult | unknown> {
    const sid = resolveSession(sessionId);
    const hint = parseRouteArg(route);
    if (coordinator.role === "follower") {
      // The executor lives on the leader (it owns sessions + bridge). Forward a
      // synthetic op so the leader runs the vm; the leader's onRpc maps it.
      // The resolved (per-process) session id is sent explicitly so parallel
      // followers never collapse onto the leader's default session.
      return coordinator.forward("__write__", { code }, sid, hint.channel, undefined, {
        file: hint.file,
        page: hint.page,
      });
    }
    const session = sessions.get(sid);
    return executeWrite(code, session, {
      // Executor's per-op runner IS validate+dispatch — no figma.* call skips
      // validation.
      runOp: async (op, params, ctx): Promise<BridgeResponse> => {
        const { op: validOp, params: validParams } = validateOperation(op, params);
        const bridge = liveBridge();
        if (!bridge) {
          throw new OpError(ErrorCode.NOT_CONNECTED, "Bridge unavailable.", "Restart the server.");
        }
        if (validOp === "list_channels") {
          return { id: "server", ok: true, result: bridge.channelSummaries() };
        }
        return bridge.dispatch(validOp, validParams, {
          ...hint,
          sessionId: sid,
          ...(ctx ? { signal: ctx.signal } : {}),
        });
      },
    });
  }

  /**
   * The plugin-state half of diagnostics, measured from a bridge this process
   * owns. Serialised verbatim over /rpc for followers (plain JSON — every field
   * is a string/number/array), so a follower sees exactly what the leader sees.
   */
  type LeaderPluginState = Pick<
    Diagnostics,
    "pluginConnected" | "plugin" | "channels" | "lastHeartbeatMs" | "queueLength" | "pendingCount"
  > & { sessions?: Diagnostics["sessions"] };

  function leaderPluginState(bridge: Bridge): LeaderPluginState {
    return {
      pluginConnected: bridge.pluginConnected,
      ...(bridge.plugin
        ? {
            plugin: {
              version: bridge.plugin.version,
              protocolVersion: bridge.plugin.protocolVersion,
              fileName: bridge.plugin.fileName,
              pageName: bridge.plugin.pageName,
              editorType: bridge.plugin.editorType,
            },
          }
        : {}),
      channels: bridge.channelSummaries().map((c) => ({
        ...c,
        boundSessions: sessions
          .summaries()
          .filter((s) => bridge.sessionBinding(s.id) === c.channel)
          .map((s) => s.id),
      })),
      lastHeartbeatMs: bridge.lastHeartbeatMs,
      queueLength: bridge.queueLength,
      pendingCount: bridge.pendingCount,
      sessions: sessions.summaries(),
    };
  }

  const diagnostics = async (): Promise<Diagnostics> => {
    const info = coordinator.info();
    const bridge = liveBridge();
    if (coordinator.role === "leader" && bridge) {
      return {
        mode: "leader",
        port: bridge.port,
        bridgeAuth: info?.token ? "ok" : "missing",
        statusSource: "local",
        ...leaderPluginState(bridge),
        leader: info,
        defaultSessionId,
        ...(bridge.sessionBinding(defaultSessionId)
          ? { boundChannel: bridge.sessionBinding(defaultSessionId) }
          : {}),
      };
    }
    // Follower: ask the LEADER for real plugin state. It must never invent one.
    const base = {
      mode: "follower" as const,
      port: info?.port ?? 0,
      bridgeAuth: (info?.token ? "ok" : "missing") as "ok" | "missing",
      leader: info,
      defaultSessionId,
    };
    try {
      const state = (await coordinator.forward(
        "__status__",
        {},
        defaultSessionId,
        undefined,
        STATUS_RPC_TIMEOUT_MS,
      )) as LeaderPluginState;
      const boundChannel = state.channels?.find((c) =>
        c.boundSessions?.includes(defaultSessionId),
      )?.channel;
      return {
        ...base,
        statusSource: "leader",
        ...state,
        ...(boundChannel ? { boundChannel } : {}),
      };
    } catch (err) {
      // __status__ failed. Before giving up, try GET /health — it carries the
      // same plugin state, needs no token, and exists in EVERY server version,
      // so a leader too old to know __status__ (mixed-version rollout) still
      // yields real state instead of a permanent "unknown".
      const health = info ? await Follower.fetchHealth(info.port, STATUS_RPC_TIMEOUT_MS) : undefined;
      if (health && typeof health.pluginConnected === "boolean") {
        return {
          ...base,
          statusSource: "leader",
          pluginConnected: health.pluginConnected,
          ...(health.plugin ? { plugin: health.plugin } : {}),
          channels: (health.channels ?? []).map((c) => ({ ...c, boundSessions: [] })),
          lastHeartbeatMs: health.lastHeartbeatMs ?? null,
          queueLength: health.queueLength ?? 0,
          pendingCount: health.pendingCount ?? 0,
        };
      }
      // UNKNOWN — NOT false. Reporting false here (the original bug) made
      // clients gate on pluginConnected and march users through pointless
      // plugin restarts while the plugin was connected and writing fine.
      return {
        ...base,
        statusSource: "unknown",
        statusError: err instanceof Error ? err.message : String(err),
        pluginConnected: null,
        lastHeartbeatMs: null,
        queueLength: 0,
        pendingCount: 0,
      };
    }
  };

  const ctx: ToolContext = { runValidated, runWrite, sessions, diagnostics };

  // Elect role + start bridge/forwarding. Bridge wiring (rpc routing, session
  // provider) happens inside the coordinator deps (runValidated /
  // onBridgeCreated) so it applies to takeover bridges too.
  await coordinator.start();

  if (coordinator.role === "follower") {
    // Register this process's session with the leader so the plugin UI's
    // picker lists every connected agent session, not just ones that have
    // already written. Best-effort: a failure just delays visibility until
    // the first write.
    void coordinator.forward("__register__", {}, defaultSessionId).catch(() => {});
  }

  const server = new Server(
    { name: "reqwise-figma-mcp", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const { name, arguments: args = {} } = req.params;
    try {
      const result = await callTool(ctx, name, args as Record<string, unknown>);
      return toToolResult(result);
    } catch (err) {
      return toToolError(err);
    }
  });

  return {
    server,
    coordinator,
    diagnostics,
    close: async () => {
      await coordinator.close();
    },
  };
}

function pickRoute(args: Record<string, unknown>): RouteArg {
  return parseRouteArg({
    channel: typeof args["channel"] === "string" ? args["channel"] : undefined,
    file: typeof args["file"] === "string" ? args["file"] : undefined,
    page: typeof args["page"] === "string" ? args["page"] : undefined,
  });
}

async function callTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "figma_status":
      return handleStatus(ctx);
    case "figma_read":
      return handleRead(
        ctx,
        String(args["op"] ?? ""),
        (args["params"] as Record<string, unknown>) ?? {},
        pickRoute(args),
      );
    case "figma_write":
      return handleWrite(
        ctx,
        String(args["code"] ?? ""),
        args["sessionId"] as string | undefined,
        pickRoute(args),
      );
    case "figma_diagram": {
      const { type, channel: _c, file: _f, page: _p, ...spec } = args;
      return handleDiagram(ctx, type, spec, pickRoute(args));
    }
    case "figma_rules":
      return handleRules(ctx, pickRoute(args));
    case "figma_docs":
      return handleDocs(String(args["section"] ?? ""), args["level"] === "cheat" ? "cheat" : "full");
    default:
      if (isProFeature(name)) {
        const pro = proFeatureMessage(name);
        throw new OpError(ErrorCode.INVALID_PARAMS, pro.message, pro.hint);
      }
      throw new OpError(ErrorCode.INVALID_PARAMS, `Unknown tool "${name}".`, "Tools: figma_status, figma_read, figma_write, figma_diagram, figma_rules, figma_docs.");
  }
}

function unwrap(res: BridgeResponse): unknown {
  if (!res.ok) {
    const e = res.error ?? { code: ErrorCode.INTERNAL, message: "Operation failed with no error detail." };
    throw new OpError(e.code, e.message, e.hint);
  }
  if (res.warnings?.length) {
    return { result: res.result, warnings: res.warnings };
  }
  return res.result;
}

/** MIME types for the raster formats screenshot/export_node can return. */
const IMAGE_MIME: Record<string, string> = {
  PNG: "image/png",
  JPG: "image/jpeg",
  JPEG: "image/jpeg",
};

/**
 * When a result carries a base64 raster image (screenshot / export_node PNG|JPG),
 * hand it to the client as a real MCP `image` content block instead of dumping
 * the base64 into a text block. Two wins: the model actually SEES the pixels
 * (a base64 text blob is invisible to it), and an image block is billed as
 * image tokens (~1.1–1.6k) rather than the 6–15k a base64 string costs as text.
 * SVG/PDF stay as data — they are not previewable image blocks — so those keep
 * the base64 in text. Returns null when the result is not a previewable image.
 */
function imageResult(result: unknown): CallToolResult | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  const base64 = r["base64"];
  const format = typeof r["format"] === "string" ? (r["format"] as string).toUpperCase() : "";
  const mime = IMAGE_MIME[format];
  if (typeof base64 !== "string" || base64.length === 0 || !mime) return null;

  // A compact metadata line so the model still gets nodeId/scale/format without
  // the base64 payload. The image block carries the actual pixels.
  const meta: Record<string, unknown> = { format };
  if (r["nodeId"] !== undefined) meta["nodeId"] = r["nodeId"];
  if (r["scale"] !== undefined) meta["scale"] = r["scale"];
  return {
    content: [
      { type: "text", text: JSON.stringify(meta) },
      { type: "image", data: base64, mimeType: mime },
    ],
  };
}

/** Wrap a successful result as an MCP tool result (markdown string, image, or JSON). */
export function toToolResult(result: unknown): CallToolResult {
  const img = imageResult(result);
  if (img) return img;
  // A warnings-wrapped result ({ result, warnings }) can still hold an image.
  if (result && typeof result === "object" && "result" in (result as object) && "warnings" in (result as object)) {
    const inner = imageResult((result as { result: unknown }).result);
    if (inner) {
      inner.content.unshift({
        type: "text",
        text: JSON.stringify({ warnings: (result as { warnings: unknown }).warnings }),
      });
      return inner;
    }
  }
  // Compact JSON — the pretty-print indent was pure whitespace tax (~20–35% of
  // every JSON response). Agents read minified JSON just as well.
  const text = typeof result === "string" ? result : JSON.stringify(result);
  return { content: [{ type: "text", text }] };
}

/** Every error to the MCP client carries {code, message, hint}. */
function toToolError(err: unknown): CallToolResult {
  const be = toBridgeError(err);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ code: be.code, message: be.message, hint: be.hint }) }],
  };
}

// ---- run as a binary ----

async function main(): Promise<void> {
  const handle = await createServer();
  const transport = new StdioServerTransport();
  await handle.server.connect(transport);

  installShutdown({ close: () => handle.close() });
}

// Only auto-run when executed directly (not when imported by tests). The
// string-compare form (`import.meta.url === "file://" + argv[1]`) silently
// failed on paths with spaces and on any launch through a symlink — including
// the npm `bin` entry — exiting 0 with no tools. isDirectRun realpaths both
// sides; see is-main.ts.
const isMain = isDirectRun(import.meta.url, process.argv[1]);

if (isMain) {
  main().catch((err) => {
    // Last-resort: report on stderr (stdout is the MCP channel).
    process.stderr.write(`[reqwise-figma-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
