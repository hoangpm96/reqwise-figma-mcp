import { describe, expect, it } from "vitest";
import { buildErd, checkErd } from "../../src/shared/erd/index.js";
import { reflowErd } from "../../src/shared/erd/route.js";
import { textWidth } from "../../src/shared/diagram/metrics.js";
import type { ErdSpec } from "../../src/shared/erd/types.js";

/**
 * A data model. The two things that can go wrong here and nowhere else: a line
 * that attaches to the wrong row (so the drawing cannot be checked against the
 * schema), and notation that says the wrong number of rows.
 */

const loan = (over: Partial<ErdSpec> = {}): ErdSpec => ({
  title: "Loan origination",
  entities: [
    {
      id: "cus",
      name: "customers",
      cls: "happy",
      attributes: [
        { name: "id", type: "uuid", key: "pk", required: true },
        { name: "national_id", type: "varchar(12)", required: true },
        { name: "full_name", type: "text", required: true },
      ],
    },
    {
      id: "app",
      name: "loan_applications",
      detail: "core.loan",
      attributes: [
        { name: "id", type: "uuid", key: "pk", required: true },
        { name: "customer_id", type: "uuid", key: "fk", required: true },
        { name: "amount", type: "numeric(14,2)", required: true },
        { name: "status", type: "text", required: true },
      ],
    },
    {
      id: "doc",
      name: "documents",
      cls: "edge",
      attributes: [
        { name: "id", type: "uuid", key: "pk" },
        { name: "application_id", type: "uuid", key: "fk" },
        { name: "kind", type: "text" },
      ],
    },
  ],
  relations: [
    { from: "cus", to: "app", fromField: "id", toField: "customer_id", label: "applies for", toCard: "zero-many" },
    { from: "app", to: "doc", fromField: "id", toField: "application_id", label: "has", toCard: "zero-many" },
  ],
  ...over,
});

/** Vertical centre of a named row, in frame coordinates. */
function rowCentre(built: ReturnType<typeof buildErd>, entity: string, column: string): number {
  const e = built.draw.entities.find((x) => x.id === entity)!;
  const index = e.attributes.findIndex((a) => a.name === column);
  return e.at.y + e.headerH + index * 24 + 12;
}

describe("an ERD", () => {
  const built = buildErd(loan());

  it("draws a table per entity, with its columns", () => {
    expect(built.draw.entities.map((e) => e.id)).toEqual(["cus", "app", "doc"]);
    const app = built.draw.entities.find((e) => e.id === "app")!;
    expect(app.attributes.map((a) => a.name)).toEqual(["id", "customer_id", "amount", "status"]);
    expect(app.attributes[0]!.badge).toBe("PK");
    expect(app.attributes[1]!.badge).toBe("FK");
    expect(app.detail).toBe("core.loan");
  });

  it("attaches each line to the COLUMN that implements it", () => {
    const line = built.draw.edges.find((e) => e.id === "cus->app")!;
    const start = line.points[0]!;
    const end = line.points[line.points.length - 1]!;
    // Leaves customers.id, arrives at loan_applications.customer_id.
    expect(start[1]).toBeCloseTo(rowCentre(built, "cus", "id"), 0);
    expect(end[1]).toBeCloseTo(rowCentre(built, "app", "customer_id"), 0);
  });

  it("puts a crow's foot on the many end and a tick on the one end", () => {
    const from = built.draw.markers.find((m) => m.id === "cus->app:from")!;
    const to = built.draw.markers.find((m) => m.id === "cus->app:to")!;
    // one → a single tick, no circle.
    expect(from.strokes).toHaveLength(1);
    expect(from.circle).toBeUndefined();
    // zero-many → the foot's two prongs, plus the optionality circle.
    expect(to.strokes).toHaveLength(2);
    expect(to.circle).toBeDefined();
  });

  it("draws the notation at the end of the line it belongs to", () => {
    const line = built.draw.edges.find((e) => e.id === "cus->app")!;
    const end = line.points[line.points.length - 1]!;
    const to = built.draw.markers.find((m) => m.id === "cus->app:to")!;
    for (const stroke of to.strokes) {
      for (const p of stroke) {
        expect(Math.hypot(p[0] - end[0], p[1] - end[1])).toBeLessThan(30);
      }
    }
  });

  it("keeps every line out of the tables it does not join", () => {
    for (const e of built.draw.edges) {
      const [from, to] = e.id.split("->");
      for (const t of built.draw.entities) {
        if (t.id === from || t.id === to) continue;
        for (let i = 1; i < e.points.length; i++) {
          const p = e.points[i - 1]!;
          const q = e.points[i]!;
          const x0 = Math.min(p[0], q[0]);
          const x1 = Math.max(p[0], q[0]);
          const y0 = Math.min(p[1], q[1]);
          const y1 = Math.max(p[1], q[1]);
          const hit = x0 < t.at.x + t.at.w && x1 > t.at.x && y0 < t.at.y + t.at.h && y1 > t.at.y;
          expect(hit, `${e.id} through ${t.id}`).toBe(false);
        }
      }
    }
  });

  it("keeps every label off the tables and off other lines", () => {
    for (const e of built.draw.edges) {
      if (!e.label) continue;
      const r = e.label;
      for (const t of built.draw.entities) {
        const hit =
          r.x < t.at.x + t.at.w && r.x + r.w > t.at.x && r.y < t.at.y + t.at.h && r.y + r.h > t.at.y;
        expect(hit, `${e.id} label over ${t.id}`).toBe(false);
      }
      for (const other of built.draw.edges) {
        if (other.id === e.id) continue;
        for (let i = 1; i < other.points.length; i++) {
          const p = other.points[i - 1]!;
          const q = other.points[i]!;
          const bx = Math.min(p[0], q[0]);
          const by = Math.min(p[1], q[1]);
          const bw = Math.abs(p[0] - q[0]);
          const bh = Math.abs(p[1] - q[1]);
          const hit = bx < r.x + r.w && bx + bw > r.x && by < r.y + r.h && by + bh > r.y;
          expect(hit, `${e.id} label over ${other.id}`).toBe(false);
        }
      }
    }
  });

  it("keeps a clean model quiet", () => {
    expect(built.warnings).toEqual([]);
    expect(built.stats).toMatchObject({ entities: 3, attributes: 10, relations: 2, manyToMany: 0 });
  });
});

describe("the proof-read", () => {
  it("names a table with no primary key", () => {
    const res = checkErd(
      [{ id: "t", name: "events", attributes: [{ name: "payload", type: "jsonb" }] }],
      [],
    );
    expect(res.warnings.join(" ")).toContain("No primary key");
  });

  it("says nothing about a table somebody else owns", () => {
    const res = checkErd(
      [
        { id: "t", name: "core_users", external: true, attributes: [{ name: "id", type: "uuid" }] },
        { id: "u", name: "profiles", attributes: [{ name: "id", type: "uuid", key: "pk" }] },
      ],
      [{ from: "t", to: "u", fromField: "id", toField: "id" }],
    );
    expect(res.warnings.join(" ")).not.toContain("No primary key");
  });

  it("catches a foreign key pointing at a column that does not exist", () => {
    const res = checkErd(
      [
        { id: "a", name: "orders", attributes: [{ name: "id", type: "uuid", key: "pk" }] },
        { id: "b", name: "lines", attributes: [{ name: "id", type: "uuid", key: "pk" }] },
      ],
      [{ from: "a", to: "b", fromField: "id", toField: "order_id" }],
    );
    expect(res.warnings.join(" ")).toContain("column that does not exist");
  });

  it("catches a type mismatch across a key", () => {
    const res = checkErd(
      [
        { id: "a", name: "orders", attributes: [{ name: "id", type: "uuid", key: "pk" }] },
        {
          id: "b",
          name: "lines",
          attributes: [
            { name: "id", type: "uuid", key: "pk" },
            { name: "order_id", type: "text", key: "fk" },
          ],
        },
      ],
      [{ from: "a", to: "b", fromField: "id", toField: "order_id" }],
    );
    expect(res.warnings.join(" ")).toContain("different types");
  });

  it("catches a many-to-many with nowhere to put the pairs", () => {
    const res = checkErd(
      [
        { id: "a", name: "students", attributes: [{ name: "id", type: "uuid", key: "pk" }] },
        { id: "b", name: "courses", attributes: [{ name: "id", type: "uuid", key: "pk" }] },
      ],
      [{ from: "a", to: "b", fromCard: "many", toCard: "many", fromField: "id", toField: "id" }],
    );
    expect(res.warnings.join(" ")).toContain("no join table");
  });

  it("names a table nothing joins to, and a mixed naming style", () => {
    const res = checkErd(
      [
        {
          id: "a",
          name: "orders",
          attributes: [
            { name: "id", type: "uuid", key: "pk" },
            { name: "customer_id", type: "uuid" },
          ],
        },
        {
          id: "b",
          name: "audit",
          attributes: [
            { name: "id", type: "uuid", key: "pk" },
            { name: "createdAt", type: "timestamptz" },
          ],
        },
      ],
      [],
    );
    const all = res.warnings.join(" ");
    expect(all).toContain("Nothing joins");
    expect(all).toContain("snake_case");
  });

  it("asks for the column when a relationship names none", () => {
    const res = checkErd(
      [
        { id: "a", name: "orders", attributes: [{ name: "id", type: "uuid", key: "pk" }] },
        { id: "b", name: "lines", attributes: [{ name: "id", type: "uuid", key: "pk" }] },
      ],
      [{ from: "a", to: "b" }],
    );
    expect(res.warnings.join(" ")).toContain("No column named");
  });
});

describe("reflowErd", () => {
  const built = buildErd(loan());
  const graph = built.draw.graph!;
  const asDrawn = () => new Map(graph.entities.map((e) => [e.id, { ...e.at }]));

  it("reproduces the drawn geometry when nothing has moved", () => {
    const res = reflowErd(graph, asDrawn());
    expect(res.moved).toEqual([]);
    expect(res.edges).toEqual(built.draw.edges);
    expect(res.markers).toEqual(built.draw.markers);
  });

  it("keeps a line on its column when the table is dragged", () => {
    const placed = asDrawn();
    const app = placed.get("app")!;
    placed.set("app", { ...app, x: app.x + 60, y: app.y + 200 });

    const res = reflowErd(graph, placed);
    expect(res.moved).toEqual(["app"]);
    const line = res.edges.find((e) => e.id === "cus->app")!;
    const end = line.points[line.points.length - 1]!;
    // customer_id is the second row: its centre is header + 1 row + half a row.
    const row = graph.entities.find((e) => e.id === "app")!.rows[1]!;
    expect(end[1]).toBeCloseTo(app.y + 200 + row.y + row.h / 2, 0);
  });

  it("moves the crow's foot with the line", () => {
    const placed = asDrawn();
    const app = placed.get("app")!;
    placed.set("app", { ...app, y: app.y + 220 });
    const res = reflowErd(graph, placed);

    const line = res.edges.find((e) => e.id === "cus->app")!;
    const end = line.points[line.points.length - 1]!;
    const marker = res.markers.find((m) => m.id === "cus->app:to")!;
    for (const stroke of marker.strokes) {
      for (const p of stroke) {
        expect(Math.hypot(p[0] - end[0], p[1] - end[1])).toBeLessThan(30);
      }
    }
  });

  it("drops a line whose table is gone", () => {
    const placed = asDrawn();
    placed.delete("doc");
    expect(reflowErd(graph, placed).dropped).toEqual(["app->doc"]);
  });
});

describe("erd key badges", () => {
  it("reserves a badge column wide enough for PK FK on one line", () => {
    // A join table's "PK FK" badge is drawn at badgeW - 8; when that was the
    // plain 30px column the text wrapped to two lines, grew the row's left
    // cell past the 24px row and layout_audit reported it clipped.
    const spec: ErdSpec = {
      title: "Join table",
      entities: [
        {
          id: "bs",
          name: "booking_seats",
          attributes: [
            { name: "booking_id", type: "uuid", key: "pfk", required: true },
            { name: "seat_id", type: "uuid", key: "pfk", required: true },
            { name: "price", type: "numeric(12,2)", required: true },
          ],
        },
      ],
      relations: [],
    };
    const table = buildErd(spec).draw.entities.find((e) => e.id === "bs")!;
    expect(table.attributes[0]!.badge).toBe("PK FK");
    expect(table.badgeW - 8).toBeGreaterThanOrEqual(textWidth("PK FK", 9));
  });

  it("leaves a plain pk/fk table on the narrow column", () => {
    const table = buildErd(loan()).draw.entities.find((e) => e.id === "app")!;
    expect(table.badgeW).toBe(30);
  });
});
