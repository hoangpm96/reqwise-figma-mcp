export const ERD = `# Data models — \`figma_diagram\` type:"erd"

Draws an entity-relationship diagram: tables with their columns, the keys that
join them, and crow's-foot cardinality at each end.

## When this, and when the others

| What the drawing answers | Tool |
|---|---|
| What does the USER see next? | \`figma_diagram\` type:"userflow" |
| WHO does this step, and what is handed over? | \`figma_diagram\` type:"activity" |
| What do we STORE, and how do the pieces refer to each other? | \`figma_diagram\` type:"erd" |

## The division of labour

**You think, the tool draws and proof-reads.** The tables, their columns and
the keys come from YOUR reading of the spec, the migration or the schema. The
tool never invents a column and never guesses a key — but it will tell you when
the model cannot work.

## Shape

\`\`\`js
{
  type: "erd",
  title: "Loan origination",
  subtitle: "core schema · v3",
  x: 80, y: 200,
  entities: [
    { id: "cus", name: "customers", cls: "happy", attributes: [
      { name: "id",          type: "uuid",        key: "pk", required: true },
      { name: "national_id", type: "varchar(12)", required: true },
      { name: "full_name",   type: "text",        required: true },
    ]},
    { id: "app", name: "loan_applications", detail: "core.loan", attributes: [
      { name: "id",          type: "uuid",          key: "pk", required: true },
      { name: "customer_id", type: "uuid",          key: "fk", required: true },
      { name: "amount",      type: "numeric(14,2)", required: true },
      { name: "status",      type: "text",          required: true },
    ]},
    { id: "doc", name: "documents", cls: "edge", attributes: [
      { name: "id",             type: "uuid", key: "pk" },
      { name: "application_id", type: "uuid", key: "fk" },
      { name: "kind",           type: "text" },
    ]},
  ],
  relations: [
    { from: "cus", to: "app", fromField: "id", toField: "customer_id",    label: "applies for", toCard: "zero-many" },
    { from: "app", to: "doc", fromField: "id", toField: "application_id", label: "has",         toCard: "zero-many" },
  ],
}
\`\`\`

### entities[]
| field | meaning |
|---|---|
| \`id\` | short key the relationships reference |
| \`name\` | the table name as it exists (or will): \`orders\`, not "Orders table" |
| \`detail\` | schema / service / storage note: \`core.orders\`, \`read model\` |
| \`attributes[]\` | \`{ name, type?, key?, required? }\` in the order they should be read. \`key\`: \`pk\` · \`fk\` · \`pfk\` (both — a join table's columns). \`required\` is NOT NULL, drawn as a dot. |
| \`cls\` | colour by meaning: \`happy\` core · \`edge\` lookup/reference · \`error\` deprecated |
| \`external\` | owned by another system: drawn dashed, and exempt from the primary-key finding |

### relations[]
\`{ from, to, fromField?, toField?, fromCard?, toCard?, label?, identifying? }\`.

**Name the columns.** \`fromField\`/\`toField\` are what make the line attach to
the row that implements the relationship instead of to the middle of a box —
which is what lets a reader check the drawing against the schema. Cardinality
is crow's foot: \`one\` · \`many\` · \`zero-one\` · \`zero-many\` · \`one-many\`,
defaulting to one → many. \`identifying\` draws the line dashed for a weak
entity. \`fromSide\`/\`toSide\` force a face when the automatic choice reads badly.

### options
| option | effect |
|---|---|
| \`rankdir\` | \`"LR"\` (default) spreads the tables left→right; \`"TB"\` stacks them downwards |
| \`font\` | family for every label. Default Inter — no CJK/Hangul glyphs |
| \`liveRoute\` | keep the lines attached when a table is dragged (default true) |
| \`dryRun\` | check the model, return warnings + size, draw nothing |

## The findings are the point

\`warnings\` reports the MODEL, not the drawing:

- **no primary key** on a table — no way to address a row, which breaks
  updates, joins and every audit trail;
- a relationship naming a **column that does not exist** — a foreign key to
  nowhere is a migration that fails at 2am;
- **many-to-many with no join table** — a relational database cannot store it;
  add the table that holds the pairs and decide what else it needs;
- a **type mismatch** across a key (\`uuid\` ↔ \`text\`) — the constraint will
  not be accepted;
- a relationship with **no column named** — the reader cannot see which key
  implements it;
- a table **nothing joins to**, duplicate column names, and snake_case mixed
  with camelCase.

Use \`options.dryRun\` to iterate on the model before anything is drawn.

## The lines follow the tables

Same as the other diagrams: while the plugin is open, dragging or resizing a
table re-routes every line touching it, and \`figma.reflowDiagram()\` fixes one
rearranged with the plugin closed. Drag a line's end onto another part of a
table and it RECONNECTS there, remembering the point.

The row a line attaches to is remembered by NAME, so moving or resizing a table
keeps the line on the right column.

## Result

\`{ frameId, name, entities: { entityId: figmaNodeId }, box, warnings, stats }\` —
\`stats.manyToMany\` is the count worth acting on before anybody writes a
migration.
`;
