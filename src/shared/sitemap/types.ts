/**
 * Sitemap: the information architecture — what PAGES exist, and which page
 * contains which.
 *
 * The other kinds answer "what does the user see on the way through"
 * (userflow), "who does this step" (activity), "what do we store" (erd), "what
 * is sent" (sequence), "what values can this hold" (state), "what is in scope"
 * (usecase) and "how does it feel" (journey). This one answers the question a
 * nav bar always raises and nobody ever writes down: what is the whole product
 * made of, and where does a given page LIVE.
 *
 * The distinction that matters, and the one this file is shaped to enforce:
 *
 *   A userflow edge is NAVIGATION — the user went from here to there.
 *   A sitemap edge is CONTAINMENT — this page lives under that one.
 *
 * They are different relations over the same boxes, and conflating them is how
 * a "sitemap" ends up being a second, worse userflow. So this kind has NO
 * edge array at all: containment is a `parent` on the page itself, and the
 * lines that get drawn carry no arrow heads. There is nowhere to write an
 * arrow, which is a stronger guarantee than a sentence in the docs.
 */
import type { DrawEdge, FlowClass, Placement, DrawFrameExtras } from "../diagram/types.js";

export type { DrawEdge, FlowClass, Placement } from "../diagram/types.js";

/**
 * What kind of thing this node is in the IA.
 *  - `page`     a real page with content of its own (the default)
 *  - `section`  a grouping that exists ONLY to hold others — a nav heading
 *               with no page behind it. A section of one child is reported,
 *               because a category of one thing is not a category.
 *  - `modal`    a dialog/sheet/drawer. NOT a navigation level: it is exempt
 *               from the depth rule, because "three clicks deep" counts pages
 *               a user navigates to, and a modal opens on top of one.
 *  - `external` somewhere off the product — a payment gateway's own pages, a
 *               help centre on another domain. Drawn dashed.
 */
export type PageKind = "page" | "section" | "modal" | "external";

export interface PageSpec {
  id: string;
  /** The page's name AS A USER WOULD SEE IT in the nav: "Cài đặt". */
  label?: string;
  /**
   * The page that CONTAINS this one — not the page you came from. Omit it on
   * the root. There is exactly one root; more than one is reported.
   */
  parent?: string;
  kind?: PageKind;
  /** Anything else a reader needs: who can see it, what is on it. */
  detail?: string;
  /**
   * The artboard(s) this page is designed as — the back-reference, and what
   * both the userflow cross-check and the coverage check match on.
   *
   * A list, because a page is usually MORE than one artboard: a list page and
   * its empty state are one page in two states, and a create dialog with a
   * validation-error frame and a submitting frame is one modal in three. The
   * FIRST entry is the page itself; the rest are states of it. Writing them
   * all down is what lets "which artboards have no home in the IA?" be asked
   * without it firing on every empty state ever designed.
   *
   * A bare string is still a page with one artboard, and stays valid.
   */
  screenId?: string | string[];
  cls?: FlowClass;
}

export interface SitemapOptions {
  /** `TB` (default) draws an org-chart tree; `LR` runs it rightwards. */
  rankdir?: "TB" | "LR";
  /**
   * `tree` (default) is the tidy-tree pass written for this kind: it keeps
   * sibling order — which in an IA is the NAV order, i.e. content — and gives
   * even sibling gaps. `dagre` hands the tree to the same engine the six graph
   * kinds use; it packs an irregular tree a little differently but is free to
   * reorder siblings to minimise crossings, of which a tree has none.
   */
  layout?: "tree" | "dagre";
  font?: string;
  /**
   * Business rules with a value, referenced from labels as `@name` and filled
   * in when the diagram is drawn. The reference is kept in the stored model,
   * so the page can be asked which frames depend on the rule.
   */
  policies?: Record<string, string | number>;
  /** Colour the line by the class of the page it leads to. Default true. */
  colorByTarget?: boolean;
  /** Keep the lines attached when a page is dragged. Default true. */
  liveRoute?: boolean;
  /**
   * How deep the IA is allowed to get before it is reported, counting the root
   * as level 1. Default 4 — i.e. three clicks from the front door, which is
   * the rule of thumb every IA guide states and the one worth checking.
   */
  maxDepth?: number;
  /** Check the tree and report, draw nothing. */
  dryRun?: boolean;
}

export interface SitemapSpec {
  /** The compact line form — use this OR `pages`. */
  text?: string;
  title: string;
  subtitle?: string;
  parentId?: string;
  x?: number;
  y?: number;
  pages?: PageSpec[];
  options?: SitemapOptions;
}

// ---- draw data (what crosses the bridge to the plugin) ----

export interface DrawPage {
  id: string;
  /** Layer name: `page:<id> · <name>`, the handle a reflow finds it by. */
  name: string;
  kind: PageKind;
  at: Placement;
  fill: string;
  stroke: string;
  /** Dashed outline for an `external` page — it is not ours to design. */
  dashed: boolean;
  radius: number;
  /** Wrapped title lines, already measured. */
  title: string[];
  /** Wrapped detail lines, drawn smaller under a gap. */
  detail: string[];
  /** Level 1..n, printed nowhere — kept so the plugin can weight the root. */
  depth: number;
  /** `· 01 · 02` under the title: every artboard this page is designed as. */
  screenId?: string[];
}

export interface SitemapDraw extends DrawFrameExtras {
  name: string;
  title: string;
  subtitle: string;
  x: number;
  y: number;
  w: number;
  h: number;
  parentId?: string;
  pages: DrawPage[];
  /** The containment lines: elbows, no arrow heads. */
  edges: DrawEdge[];
  font: string;
  /** Stored on the frame so a later drag can re-route without a redraw. */
  graph?: SitemapGraph;
}

/** What a drawn sitemap frame remembers, so it can re-route itself. */
export interface SitemapGraph {
  kind: "sitemap";
  rankdir: "TB" | "LR";
  colorByTarget: boolean;
  liveRoute: boolean;
  nodes: Array<{ id: string; kind: PageKind; cls: FlowClass; at: Placement }>;
  /**
   * One entry per containment line, parent → child. No ports and no
   * `portsByHand`: dragging the END of a containment line onto another page
   * would mean "this page now lives somewhere else", which is a change to the
   * MODEL, not to the routing — so it is not something the router may adopt
   * behind the author's back. Drag a page and the lines follow it; move a page
   * in the IA by patching its `parent`.
   */
  edges: Array<{ from: string; to: string }>;
}

export interface SitemapBuild {
  draw: SitemapDraw;
  /**
   * The merged, checked model this build came from — the same facts whether
   * they arrived as `text` or as `pages`, and with nothing about WHERE the
   * frame goes. This is what the frame stores and what a patch addresses.
   */
  model: SitemapSpec;
  warnings: string[];
  stats: {
    pages: number;
    /** Pages with no children — the leaves a user actually reads. */
    leaves: number;
    /** Levels, counting the root as 1. */
    depth: number;
    sections: number;
    w: number;
    h: number;
  };
}
