/**
 * MCP tool handlers. These sit above the coordinator: each handler shapes user
 * input, runs ops through the single validate+dispatch choke point
 * (`runValidated`, provided by index.ts) and formats a token-frugal result.
 *
 * figma_status assembles rich diagnostics + an ordered `hints` list of
 * concrete next steps (never a bare boolean). figma_rules runs the three
 * design-system reads in parallel and formats a markdown rule sheet.
 */
import {
  HEARTBEAT_DEAD_MS,
  PROTOCOL_VERSION,
  type LeaderInfo,
} from "../shared/protocol.js";
import { VERSION } from "./version.js";
import { ErrorCode, OpError } from "./errors.js";
import { validateOperation, isReadOp } from "./validate.js";
import { getDoc, DOC_SECTION_NAMES } from "./docs-content/index.js";
import type { SessionRegistry } from "./session.js";

/** Everything the tool handlers need from the running server. */
export interface ToolContext {
  /** validate → dispatch (leader) OR validate → forward (follower). */
  runValidated: (op: string, params: Record<string, unknown>, sessionId?: string, channel?: string) => Promise<unknown>;
  /** figma_write executor (leader only; followers forward a "write" pseudo-op). */
  runWrite: (code: string, sessionId?: string, channel?: string) => Promise<unknown>;
  sessions: SessionRegistry;
  diagnostics: () => Diagnostics;
}

export interface ChannelDiagnostics {
  channel: string;
  plugin: {
    version: string;
    protocolVersion: number;
    fileKey: string | null;
    fileName: string;
    pageName: string;
    editorType: string;
    connectedAt: number;
  };
  queueLength: number;
  pendingCount: number;
  lastHeartbeatMs: number;
  /** Agent sessions the user bound to this window from the plugin UI. */
  boundSessions?: string[];
}

export interface Diagnostics {
  mode: "leader" | "follower";
  port: number;
  bridgeAuth: "ok" | "missing";
  pluginConnected: boolean;
  plugin?: {
    version: string;
    protocolVersion: number;
    fileName: string;
    pageName: string;
    editorType: string;
  };
  /** One entry per connected Figma window (leader only). */
  channels?: ChannelDiagnostics[];
  lastHeartbeatMs: number;
  queueLength: number;
  pendingCount: number;
  leader?: LeaderInfo | undefined;
  /** This MCP connection's own (private) session id. */
  defaultSessionId?: string;
  /** Channel this process's session is bound to via the plugin UI, if any. */
  boundChannel?: string;
}

// ---- figma_status ----

export async function handleStatus(ctx: ToolContext): Promise<Record<string, unknown>> {
  const d = ctx.diagnostics();
  const apiVersionMatch = d.plugin ? d.plugin.protocolVersion === PROTOCOL_VERSION : null;
  const hints = buildHints(d, apiVersionMatch);

  return {
    pluginConnected: d.pluginConnected,
    mode: d.mode,
    port: d.port,
    serverVersion: VERSION,
    protocolVersion: PROTOCOL_VERSION,
    bridgeAuth: d.bridgeAuth,
    plugin: d.plugin
      ? {
          version: d.plugin.version,
          apiVersionMatch,
          fileName: d.plugin.fileName,
          pageName: d.plugin.pageName,
          editorType: d.plugin.editorType,
        }
      : null,
    channels: (d.channels ?? []).map((c) => ({
      channel: c.channel,
      fileName: c.plugin.fileName,
      pageName: c.plugin.pageName,
      queueLength: c.queueLength,
      lastHeartbeatMs: c.lastHeartbeatMs,
      ...(c.boundSessions?.length ? { boundSessions: c.boundSessions } : {}),
    })),
    lastHeartbeatMs: d.lastHeartbeatMs,
    queueLength: d.queueLength,
    pendingCount: d.pendingCount,
    sessions: ctx.sessions.summaries(),
    ...(d.defaultSessionId ? { mySessionId: d.defaultSessionId } : {}),
    ...(d.boundChannel ? { myBoundChannel: d.boundChannel } : {}),
    hints,
  };
}

/** Ordered, concrete next steps — the most actionable first. */
function buildHints(d: Diagnostics, apiVersionMatch: boolean | null): string[] {
  const hints: string[] = [];

  if (d.mode === "follower") {
    hints.push(
      "This process is a FOLLOWER; operations forward to the leader over /rpc. This is normal with multiple IDE windows.",
    );
  }
  if (d.bridgeAuth === "missing") {
    hints.push(
      "Bridge auth token is missing — leader.json was not written or is unreadable. Restart the server.",
    );
  }
  if (!d.pluginConnected) {
    hints.push(
      "No Figma plugin connected. Open Figma Desktop → Plugins → Reqwise, and keep the plugin window open.",
    );
  } else {
    if ((d.channels?.length ?? 0) > 1 && !d.boundChannel) {
      hints.push(
        `${d.channels?.length} Figma windows are connected. Pass channel in figma_write/figma_read (see channels above or figma_read {op:"list_channels"}), or ask the user to pick this session (${d.defaultSessionId ?? "?"}) in the plugin UI of the window they want.`,
      );
    }
    if (d.boundChannel) {
      hints.push(
        `This session is bound to channel "${d.boundChannel}" (picked by the user in the plugin UI) — operations route there by default.`,
      );
    }
    if (apiVersionMatch === false) {
      hints.push(
        `Plugin protocol v${d.plugin?.protocolVersion} ≠ server v${PROTOCOL_VERSION} — reinstall the plugin from plugin/manifest.json.`,
      );
    }
    if (d.lastHeartbeatMs >= 0 && d.lastHeartbeatMs > HEARTBEAT_DEAD_MS) {
      hints.push(
        `No heartbeat for ${Math.round(d.lastHeartbeatMs / 1000)}s — the Figma window may be minimized or the machine asleep.`,
      );
    }
    if (d.queueLength > 0) {
      hints.push(`${d.queueLength} operation(s) queued — the plugin is busy; batch related ops to reduce round-trips.`);
    }
  }
  if (hints.length === 0) {
    hints.push("All systems nominal. Draw with figma_write; verify with figma_read layout_audit.");
  }
  return hints;
}

// ---- figma_read ----

export async function handleRead(
  ctx: ToolContext,
  op: string,
  params: Record<string, unknown>,
  channel?: string,
): Promise<unknown> {
  if (!isReadOp(op)) {
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      `"${op}" is not a read operation.`,
      "Use figma_write for mutations. Read ops: see figma_docs(section=\"api\").",
    );
  }
  // validateOperation is applied inside runValidated (the choke point).
  return ctx.runValidated(op, params, undefined, channel);
}

// ---- figma_write ----

export async function handleWrite(
  ctx: ToolContext,
  code: string,
  sessionId?: string,
  channel?: string,
): Promise<unknown> {
  if (typeof code !== "string" || code.trim().length === 0) {
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      "figma_write requires non-empty `code`.",
      "Pass JavaScript that uses the figma.* proxy, e.g. await figma.create({type:'FRAME'}).",
    );
  }
  return ctx.runWrite(code, sessionId, channel);
}

// ---- figma_rules ----

export async function handleRules(ctx: ToolContext, channel?: string): Promise<string> {
  const [styles, variables, components] = await Promise.allSettled([
    ctx.runValidated("get_styles", {}, undefined, channel),
    ctx.runValidated("get_variables", {}, undefined, channel),
    ctx.runValidated("get_components", {}, undefined, channel),
  ]);

  const lines: string[] = ["# Design-system rule sheet", ""];

  const stylesMd = formatSection(styles, formatStyles);
  const variablesMd = formatSection(variables, formatVariables);
  const componentsMd = formatSection(components, formatComponents);

  lines.push("## Styles");
  lines.push(stylesMd);
  lines.push("");
  lines.push("## Variables");
  lines.push(variablesMd);
  lines.push("");
  lines.push("## Components");
  lines.push(componentsMd);
  lines.push("");

  // An empty rule sheet is a decision point, not a shrug: without this, agents
  // proceed to hardcode a guessed palette (observed live). Tell them exactly
  // what to do instead.
  const empty = (s: string) => s === "_none_";
  if (empty(stylesMd) && empty(variablesMd) && empty(componentsMd)) {
    lines.push("## No design system in this file — set one up BEFORE drawing");
    lines.push(
      [
        "There are no styles, variables or components to reuse. Do NOT silently invent colors:",
        "1. If the target codebase has a `design.md` (or the user gave brand colors earlier in the conversation), use those values.",
        "2. Otherwise PROPOSE a small palette to the user (primary / surface / text / muted / border, plus success / danger) and let them confirm or tweak it — one question now avoids repainting every screen later.",
        "3. Persist the agreed palette so every screen (and every future agent/session) shares it:",
        "   `await figma.setupTokens({ colors: { primary: \"#2563EB\", surface: \"#FFFFFF\", text: \"#111827\", muted: \"#6B7280\", border: \"#E5E7EB\", success: \"#16A34A\", danger: \"#DC2626\" } })`",
        "4. After the first screens exist, `figma.generateDesignMd()` produces a `design.md` you can save into the codebase for future sessions.",
      ].join("\n"),
    );
    lines.push("");
  }

  lines.push(
    "> Reuse the above before creating new nodes: figma.applyVariable for colors/numbers, figma.findOrCreateComponent for components.",
  );
  lines.push(
    "> Drawing a multi-screen flow (login/signup, onboarding, checkout…)? The screen list is almost always underspecified. Ask the user first: exact screens & order, the states each needs (empty/loading/error/success), entry variations (social/SSO/OTP/verify-email), platform & frame size, light/dark. One round of questions now beats redrawing every screen. See figma_docs(section=\"rules\") → \"Scope a flow before drawing it\".",
  );

  return lines.join("\n");
}

function formatSection(
  settled: PromiseSettledResult<unknown>,
  fmt: (v: unknown) => string,
): string {
  if (settled.status === "rejected") {
    const err = settled.reason;
    const msg = err instanceof OpError ? `${err.message}${err.hint ? ` (${err.hint})` : ""}` : String(err);
    return `_Could not load: ${msg}_`;
  }
  try {
    return fmt(settled.value);
  } catch {
    return "_none_";
  }
}

function formatStyles(v: unknown): string {
  const groups = v as { paint?: unknown[]; text?: unknown[]; effect?: unknown[] } | unknown[] | undefined;
  if (Array.isArray(groups)) {
    return groups.length ? groups.map((s) => `- ${nameOf(s)}`).join("\n") : "_none_";
  }
  const parts: string[] = [];
  for (const key of ["paint", "text", "effect"] as const) {
    const arr = groups?.[key];
    if (Array.isArray(arr) && arr.length) {
      parts.push(`**${key}**: ${arr.map(nameOf).join(", ")}`);
    }
  }
  return parts.length ? parts.join("\n\n") : "_none_";
}

interface WireVariable {
  name?: string;
  type?: string;
  values?: Record<string, unknown>;
}

/**
 * Render each variable as `name: value` (value from the FIRST/default mode)
 * rather than just its name. get_variables already serializes every mode's
 * value, so printing it here costs a few hundred tokens but saves the agent an
 * entire second get_variables round-trip (a much larger payload) just to learn
 * the hex/number behind a token name it's about to reuse.
 */
function formatVariables(v: unknown): string {
  const collections = (v as { collections?: Array<{ name?: string; modes?: Array<{ name?: string }>; variables?: WireVariable[] }> } | undefined)?.collections;
  if (!Array.isArray(collections) || collections.length === 0) {
    if (Array.isArray(v) && v.length) return v.map((x) => `- ${nameOf(x)}`).join("\n");
    return "_none_";
  }
  return collections
    .map((c) => {
      const modeNames = Array.isArray(c.modes) ? c.modes.map((m) => m?.name).filter(Boolean) : [];
      const modesLabel = modeNames.length ? modeNames.join(", ") : "default";
      const vars = Array.isArray(c.variables) ? c.variables : [];
      if (vars.length === 0) {
        return `- **${c.name ?? "collection"}** (modes: ${modesLabel}): _no variables_`;
      }
      const lines = vars.map((variable) => {
        const value = defaultModeValue(variable, modeNames[0]);
        return value !== undefined
          ? `  - ${variable.name ?? "?"}: ${value}`
          : `  - ${variable.name ?? "?"}`;
      });
      return `- **${c.name ?? "collection"}** (modes: ${modesLabel}):\n${lines.join("\n")}`;
    })
    .join("\n");
}

/** The variable's value in the default (first) mode, formatted for one line. */
function defaultModeValue(variable: WireVariable, firstMode?: string): string | undefined {
  const values = variable.values;
  if (!values || typeof values !== "object") return undefined;
  const key = firstMode && firstMode in values ? firstMode : Object.keys(values)[0];
  if (key === undefined) return undefined;
  const raw = values[key];
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === "object") {
    // alias reference from get_variables: { alias: "VariableID:..." }
    const alias = (raw as { alias?: unknown }).alias;
    return alias ? `→ ${String(alias)}` : JSON.stringify(raw);
  }
  return String(raw);
}

function formatComponents(v: unknown): string {
  const arr = Array.isArray(v) ? v : (v as { components?: unknown[] } | undefined)?.components;
  if (!Array.isArray(arr) || arr.length === 0) return "_none_";
  return arr.map((c) => `- ${nameOf(c)}`).join("\n");
}

function nameOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return String(o["name"] ?? o["key"] ?? o["id"] ?? JSON.stringify(o));
  }
  return String(v);
}

// ---- figma_docs ----

export function handleDocs(section: string): string {
  if (!section) {
    return `# figma_docs\n\nAvailable sections: ${DOC_SECTION_NAMES.join(", ")}.\nCall figma_docs({ section: "api" }) etc.`;
  }
  return getDoc(section);
}

export { validateOperation };
