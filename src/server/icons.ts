/**
 * Server-side icon support for searchIcons() and load_icon.
 *
 * - Cross-library alias map: a semantic name ("visibility", "delete", "done")
 *   resolves to the canonical icon name each library actually ships
 *   (material↔ionicons↔lucide↔tabler synonyms).
 * - searchIcons(query) returns *candidate canonical names* WITHOUT fetching
 *   any SVG — cheap, token-frugal.
 * - load_icon fetches the SVG server-side (unpkg CDN), caches it on disk under
 *   $TMPDIR/reqwise-figma-mcp/cache/, then the caller forwards the `load_icon`
 *   op to the plugin with the resolved `svg` string param.
 *
 * The network fetch is behind an injectable `fetcher` so tests never hit the
 * network. "localhost-only" applies to the Figma bridge, not icon CDNs.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheDir } from "./paths.js";
import { ErrorCode, OpError } from "./errors.js";

export type IconLibrary = "ionicons" | "lucide" | "tabler" | "bootstrap-icons";
export const DEFAULT_LIBRARY: IconLibrary = "lucide";

export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/**
 * Cross-library semantic aliases → canonical name in the *lucide/ionicons*
 * naming world. Keys are the words an AI is likely to ask for; the value is a
 * name that exists in the target libraries (we normalize per-library below).
 * ~40 common UI synonyms.
 */
export const ALIASES: Record<string, string> = {
  visibility: "eye",
  "visibility-off": "eye-off",
  hide: "eye-off",
  show: "eye",
  delete: "trash",
  remove: "trash",
  bin: "trash",
  done: "check",
  checkmark: "check",
  success: "check",
  tick: "check",
  close: "x",
  cancel: "x",
  dismiss: "x",
  clear: "x",
  add: "plus",
  create: "plus",
  new: "plus",
  minus: "minus",
  subtract: "minus",
  edit: "pencil",
  modify: "pencil",
  write: "pencil",
  settings: "settings",
  gear: "settings",
  cog: "settings",
  preferences: "settings",
  search: "search",
  find: "search",
  magnify: "search",
  home: "home",
  house: "home",
  user: "user",
  person: "user",
  account: "user",
  profile: "user",
  people: "users",
  group: "users",
  menu: "menu",
  hamburger: "menu",
  more: "more-horizontal",
  overflow: "more-vertical",
  back: "arrow-left",
  forward: "arrow-right",
  next: "arrow-right",
  previous: "arrow-left",
  up: "chevron-up",
  down: "chevron-down",
  expand: "chevron-down",
  collapse: "chevron-up",
  notification: "bell",
  alert: "bell",
  warning: "alert-triangle",
  error: "alert-circle",
  info: "info",
  help: "help-circle",
  question: "help-circle",
  favorite: "heart",
  like: "heart",
  star: "star",
  bookmark: "bookmark",
  save: "save",
  download: "download",
  upload: "upload",
  share: "share",
  link: "link",
  copy: "copy",
  calendar: "calendar",
  date: "calendar",
  clock: "clock",
  time: "clock",
  mail: "mail",
  email: "mail",
  message: "message-square",
  chat: "message-circle",
  phone: "phone",
  call: "phone",
  camera: "camera",
  image: "image",
  photo: "image",
  file: "file",
  document: "file-text",
  folder: "folder",
  lock: "lock",
  secure: "lock",
  unlock: "unlock",
  logout: "log-out",
  login: "log-in",
  refresh: "refresh-cw",
  reload: "refresh-cw",
  sync: "refresh-cw",
  filter: "filter",
  sort: "arrow-up-down",
  cart: "shopping-cart",
  bag: "shopping-bag",
  location: "map-pin",
  pin: "map-pin",
  map: "map",
  play: "play",
  pause: "pause",
  stop: "square",
  volume: "volume-2",
  mute: "volume-x",
};

/** Resolve a semantic query to a canonical icon slug (or itself if none). */
export function resolveAlias(query: string): string {
  const key = query.trim().toLowerCase().replace(/\s+/g, "-");
  return ALIASES[key] ?? key;
}

/**
 * searchIcons: return candidate canonical names, ranked. No network — this is
 * a name-resolution helper so the AI can pick before paying for a fetch.
 */
export function searchIcons(query: string, limit = 8): Array<{ name: string; alias?: string; libraries: IconLibrary[] }> {
  const norm = query.trim().toLowerCase().replace(/\s+/g, "-");
  const canonical = resolveAlias(norm);
  const results: Array<{ name: string; alias?: string; libraries: IconLibrary[] }> = [];
  const seen = new Set<string>();

  const push = (name: string, alias?: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    results.push({ name, ...(alias ? { alias } : {}), libraries: ["lucide", "ionicons", "tabler", "bootstrap-icons"] });
  };

  push(canonical, canonical !== norm ? norm : undefined);

  // Also surface other aliases whose value or key matches the query substring.
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (results.length >= limit) break;
    if (alias.includes(norm) || target.includes(norm) || norm.includes(target)) {
      push(target, alias);
    }
  }
  return results.slice(0, limit);
}

interface LibrarySpec {
  /** Build the unpkg URL for an icon name. */
  url: (name: string) => string;
}

const LIBRARIES: Record<IconLibrary, LibrarySpec> = {
  lucide: { url: (n) => `https://unpkg.com/lucide-static@latest/icons/${n}.svg` },
  ionicons: { url: (n) => `https://unpkg.com/ionicons@latest/dist/svg/${toIonicon(n)}.svg` },
  tabler: { url: (n) => `https://unpkg.com/@tabler/icons@latest/icons/outline/${n}.svg` },
  "bootstrap-icons": { url: (n) => `https://unpkg.com/bootstrap-icons@latest/icons/${n}.svg` },
};

/** Ionicons drop the -outline/-sharp suffix conventions; map a few basics. */
function toIonicon(name: string): string {
  const map: Record<string, string> = {
    trash: "trash-outline",
    eye: "eye-outline",
    "eye-off": "eye-off-outline",
    check: "checkmark-outline",
    x: "close-outline",
    plus: "add-outline",
    settings: "settings-outline",
    search: "search-outline",
    home: "home-outline",
    user: "person-outline",
  };
  return map[name] ?? `${name}-outline`;
}

const defaultFetcher: Fetcher = async (url) => {
  // Node 18+ has global fetch. Wrapped so tests can inject a fake.
  const res = await (globalThis.fetch as unknown as (u: string) => Promise<Response>)(url);
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

export interface LoadIconOptions {
  library?: IconLibrary;
  fetcher?: Fetcher;
}

/**
 * Fetch the SVG for an icon name, resolving aliases + disk cache. Returns the
 * raw SVG string. The caller then dispatches the `load_icon` op to the plugin
 * with this `svg` in params (the plugin turns SVG into Figma nodes).
 */
export async function loadIconSvg(name: string, opts: LoadIconOptions = {}): Promise<{ svg: string; canonical: string; library: IconLibrary; cached: boolean }> {
  const library = opts.library ?? DEFAULT_LIBRARY;
  const fetcher = opts.fetcher ?? defaultFetcher;
  const canonical = resolveAlias(name);

  const spec = LIBRARIES[library];
  const url = spec.url(canonical);
  const cacheFile = join(cacheDir(), `${library}__${hashName(canonical)}.svg`);

  try {
    const cached = await readFile(cacheFile, "utf8");
    if (cached.length > 0) {
      return { svg: cached, canonical, library, cached: true };
    }
  } catch {
    /* cache miss */
  }

  const res = await fetcher(url);
  if (!res.ok) {
    throw new OpError(
      ErrorCode.NODE_NOT_FOUND,
      `Icon "${name}" (resolved "${canonical}") not found in ${library} (HTTP ${res.status}).`,
      `Try searchIcons("${name}") for candidate names, or pass a different { library }.`,
    );
  }
  const svg = await res.text();
  try {
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(cacheFile, svg, { mode: 0o600 });
  } catch {
    /* cache write best-effort */
  }
  return { svg, canonical, library, cached: false };
}

function hashName(name: string): string {
  return createHash("sha1").update(name).digest("hex").slice(0, 16);
}
