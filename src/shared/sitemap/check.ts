/**
 * The proof-reading half of the sitemap tool.
 *
 * An IA tree fails in ways a picture of it hides, and every one of them is a
 * navigation bug somebody ships: a page that claims to live under something
 * that does not exist, two pages in one menu with the same word on them, a
 * "section" that groups a single item, a branch four clicks from the front
 * door. Those are the questions the spec left open, so they are reported
 * before anything is drawn.
 *
 * The bar is the same as everywhere else in this repo: a proof-reader is only
 * worth having if it is QUIET when the tree is right. Every rule here has an
 * exemption for the case where the silence is deliberate —
 *
 *   - a PAGE with one child is fine ("Liên hệ → Chi tiết liên hệ" is correct
 *     IA); only a `section`, which exists solely to group, is reported for it
 *   - the same label under DIFFERENT parents is fine ("Cài đặt" under Admin
 *     and under Hồ sơ is two menus, not a clash); only siblings are compared
 *   - a `modal` does not count as a level, because "three clicks deep" counts
 *     pages you navigate to and a dialog opens on top of one
 *   - a forest (more than one root) is DRAWN, not refused: a page mid-way
 *     through being mapped is supposed to have loose branches
 */
import { list } from "../diagram/graph.js";
import { normalize } from "../model/facts.js";
import type { PageSpec } from "./types.js";

export interface SitemapCheck {
  warnings: string[];
  /** Declaration order, with everything unreachable removed. */
  pages: PageSpec[];
  /** Page ids with no parent, in declaration order. */
  roots: string[];
  /** Child ids per parent id, in declaration order. */
  children: Map<string, string[]>;
  /** Level, counting a root as 1. */
  depth: Map<string, number>;
}

/** The default: the root plus three clicks. */
export const DEFAULT_MAX_DEPTH = 4;

/**
 * The artboards a page is designed as, however they were written.
 *
 * `screenId` takes a bare string or a list, so this is the ONE place the union
 * is unwrapped — every other reader (the layout, the cross-check, the coverage
 * check, the drawing) goes through here rather than re-deciding what a string
 * means. Blank entries are dropped: `screen:01,` should not claim an artboard
 * called "".
 */
export function artboardsOf(page: { screenId?: string | string[] }): string[] {
  const raw = page.screenId;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((v) => String(v ?? "").trim()).filter(Boolean);
}

export function checkSitemap(rawPages: PageSpec[], maxDepth = DEFAULT_MAX_DEPTH): SitemapCheck {
  const warnings: string[] = [];

  // ---- one declaration per id ----
  const declared: PageSpec[] = [];
  const byId = new Map<string, PageSpec>();
  for (const p of rawPages) {
    if (!p || typeof p !== "object" || typeof p.id !== "string" || !p.id) continue;
    if (byId.has(p.id)) {
      warnings.push(`Duplicate page id "${p.id}" — the later declaration was dropped.`);
      continue;
    }
    byId.set(p.id, p);
    declared.push(p);
  }

  const nameOf = (id: string): string => {
    const label = (byId.get(id)?.label ?? "").trim();
    return label ? label : id;
  };

  // ---- who contains whom ----
  // A parent that was never declared is the commonest typo in a hand-written
  // tree, and it takes the page's whole subtree with it — so the finding says
  // how many pages went, not just the one that named the missing id.
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  const danglers: PageSpec[] = [];
  for (const p of declared) {
    const parent = (p.parent ?? "").trim();
    if (!parent) {
      roots.push(p.id);
      continue;
    }
    if (parent === p.id) {
      // Its own parent: a one-node cycle, and the reachability walk below
      // would never see it. Say the specific thing rather than the generic.
      danglers.push(p);
      continue;
    }
    if (!byId.has(parent)) {
      danglers.push(p);
      continue;
    }
    const bucket = children.get(parent);
    if (bucket) bucket.push(p.id);
    else children.set(parent, [p.id]);
  }

  // ---- what the tree actually reaches ----
  const depth = new Map<string, number>();
  const order: string[] = [];
  const walk = (id: string, level: number): void => {
    if (depth.has(id)) return;
    depth.set(id, level);
    order.push(id);
    for (const kid of children.get(id) ?? []) walk(kid, level + 1);
  };
  for (const id of roots) walk(id, 1);

  const unreachable = declared.filter((p) => !depth.has(p.id));
  if (danglers.length) {
    const lost = danglers.map((p) => {
      const subtree = countSubtree(p.id, children);
      return subtree > 0
        ? `"${nameOf(p.id)}" (${p.parent === p.id ? "its own parent" : `no page called "${p.parent}"`}, and ${subtree} page(s) under it)`
        : `"${nameOf(p.id)}" (${p.parent === p.id ? "its own parent" : `no page called "${p.parent}"`})`;
    });
    warnings.push(
      `Dropped, because nothing contains ${danglers.length > 1 ? "them" : "it"}: ${list(lost)}. A page's \`parent\` is the page it LIVES UNDER — declare that page, or fix the id.`,
    );
  }
  // Anything still unreached, minus the danglers and their subtrees, is in a
  // containment cycle: a is under b and b is under a, which no tree can hold
  // and which the layout would walk forever.
  const dangled = new Set<string>();
  for (const p of danglers) markSubtree(p.id, children, dangled);
  const cyclic = unreachable.filter((p) => !dangled.has(p.id));
  if (cyclic.length) {
    warnings.push(
      `Containment cycle — dropped: ${list(cyclic.map((p) => `"${nameOf(p.id)}" under "${nameOf(p.parent ?? "")}"`))}. Two pages cannot each live inside the other; one of them belongs higher up.`,
    );
  }

  const pages = declared.filter((p) => depth.has(p.id));
  const liveChildren = new Map<string, string[]>();
  for (const id of order) {
    const kids = (children.get(id) ?? []).filter((k) => depth.has(k));
    if (kids.length) liveChildren.set(id, kids);
  }

  // ---- where it starts ----
  if (!pages.length) {
    warnings.push(
      danglers.length || cyclic.length
        ? "Nothing left to draw: every page named a parent that does not exist, or sat in a cycle."
        : "No pages — nothing to draw.",
    );
    return { warnings, pages, roots: [], children: liveChildren, depth };
  }
  if (roots.length > 1) {
    warnings.push(
      `${roots.length} pages with no parent (${list(roots.map((id) => `"${nameOf(id)}"`))}). A sitemap has ONE front door — the others are either pages that belong somewhere under it, or a second sitemap. Drawn side by side so you can see what is loose.`,
    );
  }

  // ---- how deep ----
  // A `modal` is not a level: a dialog opens on top of the page you are on, so
  // counting it would report a depth the user never navigates.
  const deep = pages.filter((p) => (depth.get(p.id) ?? 1) > maxDepth && p.kind !== "modal");
  if (deep.length) {
    const worst = Math.max(...pages.map((p) => (p.kind === "modal" ? 0 : (depth.get(p.id) ?? 1))));
    warnings.push(
      `${deep.length} page(s) are ${maxDepth + 1}+ levels deep (deepest ${worst}): ${list(deep.slice(0, 6).map((p) => `"${nameOf(p.id)}"`))}. That is ${worst - 1} clicks from the front door — either the middle levels are doing no work and can be collapsed, or ${deep.length > 1 ? "those pages" : "that page"} needs reaching another way (search, a shortcut in the nav). Raise options.maxDepth if this IA is deliberately deep.`,
    );
  }

  // ---- a category of one ----
  // A `section` exists ONLY to group, so a section that groups fewer than two
  // things is a contradiction. A `page` with one child is NOT: "Liên hệ →
  // Chi tiết liên hệ" is what correct IA looks like, and warning about it
  // would teach people to flatten a tree that is already right.
  const thin = pages.filter((p) => p.kind === "section" && (liveChildren.get(p.id) ?? []).length < 2);
  if (thin.length) {
    warnings.push(
      `Section${thin.length > 1 ? "s" : ""} that group${thin.length > 1 ? "" : "s"} fewer than two pages: ${list(
        thin.map((p) => `"${nameOf(p.id)}" (${(liveChildren.get(p.id) ?? []).length})`),
      )}. A section is a heading with no page behind it, so one of one thing is a level the user clicks through for nothing — merge it into its child, or make it kind:"page" if it really is a page.`,
    );
  }

  // ---- two pages, one word, one menu ----
  // Compared among SIBLINGS only. The same label under different parents is
  // normal ("Cài đặt" under Admin and under Hồ sơ are two different menus);
  // two of them in ONE menu is a thing a user cannot tell apart.
  for (const [parent, kids] of [...liveChildren, ["", roots] as [string, string[]]]) {
    const byLabel = new Map<string, string[]>();
    for (const id of kids) {
      const key = normalize(nameOf(id));
      const bucket = byLabel.get(key);
      if (bucket) bucket.push(id);
      else byLabel.set(key, [id]);
    }
    for (const [, ids] of byLabel) {
      if (ids.length < 2) continue;
      const where = parent ? `under "${nameOf(parent)}"` : "at the top level";
      warnings.push(
        `${ids.length} pages ${where} are both called "${nameOf(ids[0]!)}" (${ids.map((i) => `\`${i}\``).join(", ")}). They sit in the same menu, so a user cannot tell them apart — rename one, or they are the same page written twice.`,
      );
    }
  }

  // ---- one artboard, two pages ----
  // Now that a page names several artboards, the same one can be claimed
  // twice — and then "which page is this screen on?" has two answers while
  // both drawings look right. Cheap to check, impossible to see by eye once a
  // page lists five.
  const claimedBy = new Map<string, string[]>();
  for (const p of pages) {
    for (const art of artboardsOf(p)) {
      const key = art.toLowerCase();
      const bucket = claimedBy.get(key);
      if (bucket) bucket.push(p.id);
      else claimedBy.set(key, [p.id]);
    }
  }
  for (const [art, owners] of claimedBy) {
    if (owners.length < 2) continue;
    warnings.push(
      `Artboard "${art}" is claimed by ${owners.length} pages (${list(owners.map((id) => `"${nameOf(id)}"`))}). One screen lives in one place — decide which page it belongs to, or it is two different screens that need two names.`,
    );
  }

  // ---- a tree with no branches ----
  if (pages.length > 1 && !liveChildren.size) {
    warnings.push(
      "No page contains another — a flat list of pages is a list, not an information architecture. Say which page each one lives under with `parent`.",
    );
  }

  // An `external` page with children says we designed pages inside somebody
  // else's product. Almost always a mis-marked node.
  const owned = pages.filter((p) => p.kind === "external" && (liveChildren.get(p.id) ?? []).length > 0);
  if (owned.length) {
    warnings.push(
      `External page${owned.length > 1 ? "s" : ""} with pages inside: ${list(owned.map((p) => `"${nameOf(p.id)}"`))}. \`external\` means it is not ours to design — if we own what is under it, it is not external.`,
    );
  }

  return { warnings, pages, roots, children: liveChildren, depth };
}

/** How many pages hang off this one, following `parent` links downwards. */
function countSubtree(id: string, children: Map<string, string[]>): number {
  const seen = new Set<string>();
  markSubtree(id, children, seen);
  seen.delete(id);
  return seen.size;
}

/** Collect `id` and everything under it, cycle-safe. */
function markSubtree(id: string, children: Map<string, string[]>, into: Set<string>): void {
  if (into.has(id)) return;
  into.add(id);
  for (const kid of children.get(id) ?? []) markSubtree(kid, children, into);
}
