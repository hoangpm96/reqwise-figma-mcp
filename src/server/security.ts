/**
 * Shared security helpers for the local bridge.
 *
 * Threat model (localhost, same OS user): the bridge binds 127.0.0.1 only.
 * A process running as the same user can read leader-*.json (mode 0600) and
 * call /rpc — that is intentional for follower MCP processes. What we harden
 * against is *casual* local abuse: unauthenticated WS channel theft via
 * /health leaks, SSRF through loadImage, and icon-name path injection on CDNs.
 */
import { timingSafeEqual, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { OpError } from "./errors.js";
import { ErrorCode } from "../shared/protocol.js";

/** Constant-time string compare; unequal lengths are not equal. */
export function safeEqualString(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Fresh resume token for a plugin channel (hex, 24 bytes). */
export function newResumeToken(): string {
  return randomBytes(24).toString("hex");
}

/**
 * Icon / SVG catalogue names that are safe to interpolate into CDN paths.
 * Rejects path segments, query strings, and anything outside [a-z0-9-].
 */
export function assertSafeIconName(name: string): string {
  const n = name.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(n) || n.length > 64) {
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      `Icon name "${name}" is not allowed.`,
      "Use a simple kebab-case name like \"arrow-right\" (letters, digits, hyphens only).",
    );
  }
  return n;
}

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

function isPrivateOrLocalIp(ip: string): boolean {
  const v4 = ip.includes(".") ? ip : null;
  if (!v4) {
    const g = ipv6Groups(ip);
    if (!g) return false;
    if (g.every((x) => x === 0)) return true; // :: unspecified — routes to loopback
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
    if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    // Embedded IPv4 in the last 32 bits — IPv4-mapped ::ffff:x (any spelling,
    // including the hex form ::ffff:7f00:1) and the NAT64 well-known prefix
    // 64:ff9b::/96. Re-check the embedded address against the v4 rules.
    const embedded =
      (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) ||
      (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0);
    if (embedded) {
      return isPrivateOrLocalIp(`${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`);
    }
    return false;
  }
  const parts = v4.split(".").map((x) => Number(x));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/**
 * Expand an IPv6 literal (lowercased, brackets and any %zone already
 * stripped) to its 8 16-bit groups, or null if it is not valid IPv6. Handles
 * `::` compression and a trailing dotted-quad (`::ffff:1.2.3.4`).
 */
function ipv6Groups(ip: string): number[] | null {
  // A dotted-quad tail contributes the last two groups.
  let tail: number[] = [];
  const m = /:([0-9]{1,3}(?:\.[0-9]{1,3}){3})$/.exec(ip);
  if (m) {
    const q = m[1]!.split(".").map(Number);
    if (q.some((n) => n > 255)) return null;
    tail = [(q[0]! << 8) | q[1]!, (q[2]! << 8) | q[3]!];
    ip = ip.slice(0, m.index);
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const h of s.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(h)) return null;
      out.push(parseInt(h, 16));
    }
    return out;
  };
  const left = parse(halves[0]!);
  const right = halves.length === 2 ? parse(halves[1]!) : [];
  if (!left || !right) return null;
  const missing = 8 - (left.length + right.length + tail.length);
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  return [...left, ...Array<number>(missing).fill(0), ...right, ...tail];
}

/**
 * Validate a loadImage URL: https only, no credentials, no private/link-local
 * / metadata hosts. DNS rebinding is out of scope for this local tool; we
 * still refuse literal private IPs and well-known metadata hostnames.
 */
export function assertSafeImageUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      `Invalid image URL: "${raw}"`,
      "Pass an https URL, a data: URI, or raw base64.",
    );
  }
  if (url.protocol !== "https:") {
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      `Image URL must be https (got ${url.protocol}).`,
      "Pass an https URL, a data: URI, or raw base64 — http and file URLs are blocked.",
    );
  }
  if (url.username || url.password) {
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      "Image URL must not include credentials.",
      "Remove userinfo from the URL.",
    );
  }
  // Normalize before matching: drop IPv6 brackets and any %zone suffix, then
  // a single trailing dot — "localhost." still resolves to 127.0.0.1.
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      `Image host "${host}" is blocked.`,
      "loadImage cannot fetch localhost, link-local, or cloud metadata endpoints.",
    );
  }
  if (isIP(host) && isPrivateOrLocalIp(host)) {
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      `Image host "${host}" is a private or local address.`,
      "loadImage only fetches public https URLs.",
    );
  }
  return url;
}
