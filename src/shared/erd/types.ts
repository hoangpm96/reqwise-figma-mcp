/**
 * Entity-relationship diagram: the data model behind the process.
 *
 * A userflow answers "what does the user see next", an activity "who does this
 * step" — an ERD answers "what do we store, and how do the pieces refer to
 * each other". The findings it can report are the ones that bite later: a
 * table with no primary key, a foreign key pointing at a column that does not
 * exist, a many-to-many nobody has given a join table to.
 */
import type { DrawEdge, FlowClass, Placement, DrawFrameExtras } from "../diagram/types.js";
import type { Port, Side } from "../diagram/connector.js";

/** How many rows on this side of a relationship, in crow's-foot terms. */
export type Cardinality = "one" | "many" | "zero-one" | "zero-many" | "one-many";

export interface ErdAttributeSpec {
  name: string;
  /** Column type as the reader will see it in the database: `uuid`, `varchar(255)`. */
  type?: string;
  /** `pk` primary key · `fk` foreign key · `pfk` both (a join table's columns). */
  key?: "pk" | "fk" | "pfk";
  /** NOT NULL. Drawn as a dot next to the name. */
  required?: boolean;
}

export interface ErdEntitySpec {
  id: string;
  /** Table name as it exists (or will exist) — `orders`, not "Orders table". */
  name: string;
  /** Schema, service or storage note: `core.orders`, `read model`. */
  detail?: string;
  attributes: ErdAttributeSpec[];
  /** Colour by meaning: `happy` core · `edge` lookup/reference · `error` deprecated. */
  cls?: FlowClass;
  /** Owned by another system: drawn dashed, and exempt from the PK finding. */
  external?: boolean;
}

export interface ErdRelationSpec {
  from: string;
  to: string;
  /** Rows at the `from` end. Default `one`. */
  fromCard?: Cardinality;
  /** Rows at the `to` end. Default `many`. */
  toCard?: Cardinality;
  /** The verb, read from `from` to `to`: "places", "contains", "is billed to". */
  label?: string;
  /** Column that implements the relationship — the line attaches to that row. */
  fromField?: string;
  toField?: string;
  /** A weak entity's dependency, drawn dashed. */
  identifying?: boolean;
  /** Which face each end attaches to, when the automatic choice reads badly. */
  fromSide?: Side;
  toSide?: Side;
}

export interface ErdOptions {
  /** `LR` (default) spreads the tables left→right; `TB` stacks them downwards. */
  rankdir?: "TB" | "LR";
  font?: string;
  /**
   * Business rules with a value, referenced from labels as `@name` and filled
   * in when the diagram is drawn. The reference is kept in the stored model,
   * so the page can be asked which frames depend on the rule.
   */
  policies?: Record<string, string | number>;
  /** Keep the lines attached when a table is dragged. Default true. */
  liveRoute?: boolean;
  /** Check the model and report, draw nothing. */
  dryRun?: boolean;
}

export interface ErdSpec {
  /**
   * The compact line form of the model — use this OR the arrays below. Costs
   * roughly a third of the tokens; the parser reports any line it cannot read
   * rather than dropping it.
   */
  text?: string;
  title: string;
  subtitle?: string;
  parentId?: string;
  x?: number;
  y?: number;
  entities?: ErdEntitySpec[];
  relations?: ErdRelationSpec[];
  options?: ErdOptions;
}

// ---- draw data (what crosses the bridge to the plugin) ----

export interface DrawAttribute {
  name: string;
  type: string;
  /** "PK" · "FK" · "PK FK" · "" */
  badge: string;
  required: boolean;
  /** Row height, so the plugin does not have to re-derive it. */
  h: number;
}

export interface DrawEntity {
  id: string;
  /** Layer name: `entity:<id> · <name>`, the handle a reflow finds it by. */
  name: string;
  title: string;
  detail?: string;
  at: Placement;
  /** Height of the title block; the rows follow it. */
  headerH: number;
  headerFill: string;
  stroke: string;
  dashed: boolean;
  /** Width reserved for the key badge column, 0 when no attribute has a key. */
  badgeW: number;
  attributes: DrawAttribute[];
}

/** A crow's-foot (or tick, or circle) at one end of a relationship line. */
export interface DrawMarker {
  /** `<edge id>:from` / `<edge id>:to`. */
  id: string;
  /** Open polylines drawn at the end, already in frame coordinates. */
  strokes: Array<Array<[number, number]>>;
  /** Circle centre + radius for the "zero" part, when the cardinality has one. */
  circle?: { x: number; y: number; r: number };
  color: string;
}

export interface ErdDraw extends DrawFrameExtras {
  name: string;
  title: string;
  subtitle: string;
  x: number;
  y: number;
  w: number;
  h: number;
  parentId?: string;
  entities: DrawEntity[];
  edges: DrawEdge[];
  markers: DrawMarker[];
  font: string;
  graph?: ErdGraph;
}

/** What a drawn ERD frame remembers, so it can re-route itself. */
export interface ErdGraph {
  kind: "erd";
  rankdir: "TB" | "LR";
  liveRoute: boolean;
  entities: Array<{
    id: string;
    at: Placement;
    headerH: number;
    /** Row offsets from the box top, so a line can find its column again. */
    rows: Array<{ name: string; y: number; h: number }>;
  }>;
  relations: Array<{
    from: string;
    to: string;
    fromCard: Cardinality;
    toCard: Cardinality;
    fromField?: string;
    toField?: string;
    identifying: boolean;
    labelLines: string[];
    lw: number;
    lh: number;
    fromPort?: Port;
    toPort?: Port;
    portsByHand?: boolean;
  }>;
}

export interface ErdBuild {
  draw: ErdDraw;
  /**
   * The merged, checked model this build came from — the same facts
   * whether they arrived as `text` or as the arrays, and with nothing
   * about WHERE the frame goes. This is what the frame stores and what
   * a patch addresses.
   */
  model: ErdSpec;
  warnings: string[];
  stats: {
    entities: number;
    attributes: number;
    relations: number;
    manyToMany: number;
    w: number;
    h: number;
  };
}
