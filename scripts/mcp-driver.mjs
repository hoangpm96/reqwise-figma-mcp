#!/usr/bin/env node
/**
 * Drive this MCP server over stdio with no MCP client.
 *
 * The reqwise tools are not loaded in every Claude Code / Codex session, and
 * a live Figma window is the only way to find the bugs that unit tests cannot
 * see. This spawns `dist/server/index.js`, speaks JSON-RPC at it, and prints
 * `[timing] <tool> <ms> req=<B> resp=<B>` for each step.
 *
 *   npm run build
 *   echo '[{"name":"figma_status","arguments":{}}]' > /tmp/s.json
 *   node scripts/mcp-driver.mjs /tmp/s.json
 *
 * Step file: [{ name, arguments, note?, capture?: { var: "path.in.result" },
 * stopOnError? }]. `{{var}}` anywhere in a later step's arguments is replaced
 * with what `capture` picked up. Image blocks are written out as PNG.
 * A step of `{ sleep: <ms> }` just waits — see the reconnection note below.
 *
 * A capture value may also be `{ where: {field: "substring"}, take: "path" }`
 * to pick an array element by content rather than by index — which is how you
 * target a named Figma window instead of whichever one reconnected first.
 *
 * Gotchas worth knowing before you blame the code:
 *  - `figma_read` params are NESTED: { op, params: { nodeId } }.
 *  - Ops are validated by whichever server holds port 38470. If a new op comes
 *    back UNSUPPORTED_OPERATION, that leader is older than your build —
 *    `figma_status` says leader/follower; kill the holder and the next server
 *    elects itself (the plugin then needs ~30s to reconnect).
 *  - A PLUGIN_TIMEOUT does not cancel the plugin: the draw usually landed.
 *    Read the page before retrying, or you will draw it twice.
 *  - This script KILLS its server when the steps finish. If that server was
 *    the leader, every connected plugin re-handshakes and gets a NEW channel
 *    name — so a channel copied from one run is dead by the next. With more
 *    than one Figma window open, put `list_channels` FIRST in the step file
 *    and capture from it; a hardcoded channel gets CHANNEL_NOT_FOUND.
 *  - `list_channels` answers a BARE ARRAY, so the capture path is
 *    `0.channel`, not `channels.0.channel`. A path that misses captures
 *    nothing, `{{ch}}` is left as-is, and two windows then give you
 *    AMBIGUOUS_CHANNEL rather than anything about the typo.
 *  - `figma_write` runs on the LEADER, not here: a follower forwards the whole
 *    code string as a synthetic `__write__` op, because the executor owns the
 *    sessions and the bridge (see the comment on `runWrite` in index.ts). So a
 *    NEW `figma.*` sandbox method stays invisible — "figma.x is not a sandbox
 *    method" — until the leader is running the new build, however fresh the
 *    dist this script spawns is. `figma_diagram` is not affected: its layout
 *    runs locally and only the `create_*` op forwards. To test a new sandbox
 *    method, become the leader: kill the holder of 38470 (`lsof -nP
 *    -iTCP:38470 -sTCP:LISTEN`) and the next server elects itself.
 *  - Rebuilding `plugin/code.js` does NOT reach the plugin already running in
 *    Figma: anything drawn by the plugin (a handler, layout_audit) still uses
 *    the bundle loaded when it started. Re-run the plugin from
 *    Plugins → Development before verifying a plugin-side fix. Server-side
 *    fixes (layout, checkers, patch) take effect immediately.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// Repo root from this script's own location (scripts/), not cwd and not a
// machine-specific absolute path — the driver is run from anywhere.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Images go to a temp dir, never next to this script — it is committed.
const OUT = path.join(os.tmpdir(), 'reqwise-mcp-driver');
const steps = JSON.parse(readFileSync(process.argv[2], 'utf8'));

const srv = spawn('node', [path.join(ROOT, 'dist/server/index.js')], {
  cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'],
});
srv.stderr.on('data', d => process.stderr.write('[srv] ' + d));

/** Dotted lookup, for the capture selectors. */
const pluck = (o, path) => (path ? String(path).split('.').reduce((a, s) => a?.[s], o) : o);

let buf = '';
const pending = new Map();
srv.stdout.on('data', d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});

let id = 0;
const rpc = (method, params) => new Promise((res, rej) => {
  const myId = ++id;
  pending.set(myId, m => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error('timeout ' + method)); } }, 120000);
});

const ctx = {};
const subst = (o) => JSON.parse(JSON.stringify(o).replace(/\{\{(\w+)\}\}/g, (_, k) => ctx[k] ?? ''));

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'driver', version: '1' } });
srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

for (const step of steps) {
  // `{ "sleep": 15000 }` — wait, and call nothing. Killing the leader makes
  // every Figma window reconnect one at a time, so a step file that targets a
  // NAMED window has to give the slow one time to arrive: capturing the
  // channel while only the other window is back aims the whole run at the
  // wrong file (or dies on AMBIGUOUS_CHANNEL two steps later).
  if (typeof step.sleep === 'number') {
    process.stdout.write(`\n=== sleep ${step.sleep}ms ${step.note ?? ''} ===\n`);
    await new Promise(r => setTimeout(r, step.sleep));
    continue;
  }
  const args = subst(step.arguments ?? {});
  process.stdout.write(`\n=== ${step.name} ${step.note ?? ''} ===\n`);
  let r;
  const t0 = Date.now();
  try { r = await rpc('tools/call', { name: step.name, arguments: args }); }
  catch (e) { process.stdout.write('ERROR ' + e.message + '\n'); if (step.stopOnError !== false) break; continue; }
  const reqBytes = JSON.stringify(args).length;
  let respBytes = 0;
  for (const c of r.content ?? []) respBytes += c.type === 'text' ? c.text.length : (c.data?.length ?? 0);
  process.stdout.write(`[timing] ${step.name} ${Date.now() - t0}ms req=${reqBytes}B resp=${respBytes}B\n`);
  for (const c of r.content ?? []) {
    if (c.type === 'text') {
      process.stdout.write(c.text + '\n');
      try {
        const j = JSON.parse(c.text);
        if (step.capture) for (const [k, spec] of Object.entries(step.capture)) {
          // A string is a plain path. An object is `{ path, where: {field: value} }`
          // and picks the first ARRAY element whose field contains that value.
          //
          // Worth the twenty lines: `list_channels` answers an array whose
          // ORDER is whatever order the plugins reconnected in, so capturing
          // `0.channel` picked a different Figma window between two runs and
          // aimed a redraw at the wrong file. It failed safely — `update:`
          // refuses a frame id it cannot find — but "failed safely" is luck,
          // not a design, and the next op might not have an id to check.
          const path = typeof spec === 'string' ? spec : spec.path;
          let v = (path ? path.split('.') : []).reduce((a, s) => a?.[s], j);
          if (typeof spec === 'object' && spec.where) {
            const src = Array.isArray(v) ? v : Array.isArray(j) ? j : [];
            const [field, want] = Object.entries(spec.where)[0];
            const hit = src.find(e => JSON.stringify(pluck(e, field) ?? '').includes(want));
            if (!hit) {
              process.stderr.write(`[capture] ${k}: nothing where ${field} ~ ${want}\n`);
              continue;
            }
            v = pluck(hit, spec.take || path);
          }
          if (v != null) { ctx[k] = v; process.stdout.write(`[capture] ${k}=${v}\n`); }
        }
      } catch {}
    } else if (c.type === 'image') {
      mkdirSync(OUT, { recursive: true });
      const f = path.join(OUT, `${step.name}-${Date.now()}.png`);
      writeFileSync(f, Buffer.from(c.data, 'base64'));
      process.stdout.write(`[image] ${f}\n`);
    }
  }
}
srv.kill();
process.exit(0);
