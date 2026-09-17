---
name: figma-erd
description: Draw a data model on Figma — tables, columns, keys and crow's-foot cardinality — when the open question is what we store and how the pieces refer to each other. Reports the model problems that bite after a migration.
allowed-tools: Read, Glob, Grep, AskUserQuestion, mcp__reqwise-figma__figma_status, mcp__reqwise-figma__figma_docs, mcp__reqwise-figma__figma_read, mcp__reqwise-figma__figma_diagram, mcp__reqwise-figma__figma_write
user-invocable: true
argument-hint: "<the data model> [source file, schema, or @tag]"
---

# /figma-erd — What we store, and how it joins

Read `../reqwise-diagram-rules.md` first — connection gate, the four levels of correct, the
findings loop, frame placement, verification. This file carries only what is specific to an
ERD.

## Goal

Make the data model reviewable by people who will not read a migration. Tables, the columns
that matter, and — the part that is usually wrong — **which column joins to which**, and how
many of each side.

Output: one Figma frame `ERD · <title>`, plus the model problems it exposed.

## Constraints

### Hard rules — never violate

- **Name the columns on every relation.** `fromField` and `toField` are what make the line
  attach to the row that actually implements the relationship, and what lets a reader check
  the picture against the schema. A relation without them is a decorative line.
- **Every table gets a primary key** unless it is `external: true` (a table another system
  owns). The tool reports the ones that do not.
- **Use the real names.** `loan_applications`, `customer_id` — the names in the database or
  the ones the team has agreed to use. A pretty diagram with invented names is worse than no
  diagram, because someone will code against it.
- **Pick one naming convention and hold it.** `snake_case` or `camelCase`, not both. Mixing
  them is reported, and it is reported because it is always a merge of two people's work that
  nobody reconciled.
- **Never invent a column to make a join work.** A relation naming a column that does not
  exist is a finding about the model, not a typo to paper over.

### Write it in the compact form

`text` is a table, then its indented columns, then the relations. Unlike mermaid's `erDiagram`,
the relation line **names the columns on both sides** — which is the whole point of an ERD
line and the thing that makes it checkable against the schema.

```
users happy / core.auth          # class, and a detail line after "/"
  id uuid pk!                    # ! = NOT NULL
  email varchar(255)!
  created_at timestamptz
bookings
  id uuid pk!
  user_id uuid fk!
  status varchar(16)!
booking_seats                    # the join table, spelled out
  booking_id uuid pfk!
  seat_id uuid pfk!
psp_transactions ext / owned by the payment gateway
  reference varchar(64)!
  booking_id uuid fk!
users.id 1-* bookings.user_id "books"
bookings.id 1-? psp_transactions.booking_id "paid by"    # ? = zero-one, so it is optional
bookings.id 1=+ booking_seats.booking_id "holds"      # = identifying, + one-many
```

Cardinality is one character a side — `1` one · `?` zero-one · `*` zero-many · `+` one-many —
and the character between them is `-` for a normal relationship, `=` for an identifying one.
Mermaid's `||--o{` tokens are accepted too, because a model reaches for them by habit.

### The relation table — read this before writing a single relation

| Want to say | Write | NOT |
|---|---|---|
| One customer has many applications | `users.id 1-* bookings.user_id "books"` | omitting the column names, or guessing which side is "many" |
| Exactly one, always | `1-1` | leaving the default and hoping |
| Optional on one side | `1-?` / `1-*` | `1-1` / `1-+`, which claim it is mandatory |
| Many-to-many | a **join table** with two `pfk!` columns and two relations into it | `*-*` |
| The child cannot exist without the parent | `1=+` — the `=` is identifying | a note in the label |
| What the relationship means to the business | the quoted label at the end | leaving it blank, or writing "1-n" |
| A table another system owns | `ext` on the table line | pretending we own it, then failing the PK check |

Many-to-many is the one that fights the habit. It is writable and it is never implementable.
The tool reports it because the join table is a decision somebody has to make, and making it
*now* is cheaper than making it in a migration.

### Pitfalls — easy to get wrong

- **This is not the whole schema.** Show the tables the feature touches and the columns that
  carry meaning — keys, the status, the money, the dates. Twenty audit columns per table make
  the diagram unreadable and tell the reader nothing.
- **Types must match across a key.** `uuid` joining to `varchar(36)` works until it does not.
  The tool reports the mismatch; treat it as real.
- **`key: "pfk"`** is for a column that is both — the classic join-table primary key.
- **An orphan table is a question**, not a layout problem: why is it on this diagram if
  nothing joins to it?
- **Enum values are not a table.** A status with five values is a column with a comment or a
  `/figma-state` diagram, not five rows.
- **Do not draw the ERD before the state machine** when the feature is about a lifecycle. The
  status column's *values* are the interesting part, and this diagram will not show them.

## Inputs

```
/figma-erd "Vay tín chấp"                          # interview from scratch
/figma-erd "Đơn hàng" @db/schema.sql               # derive from a real schema
/figma-erd "Vay tín chấp" @docs/srs/spec.md        # derive from a spec
/figma-erd                                          # asks which model
```

If a real schema, migration or ORM model is available, **read it** rather than interviewing —
it is the only source that is definitely true. Interview only for the parts it cannot tell you
(what a relationship means, whether a nullable FK is genuinely optional).

## Approach

### Phase 0 — Connection

Per shared rules §5.

### Phase 1 — Derive the model, and name the gaps

Build the **fact-list**:

1. **The tables** this feature reads or writes, with their real names.
2. **For each**: primary key, foreign keys, and the handful of columns that carry business
   meaning.
3. **Every relation**: which column joins to which, and the cardinality on both ends —
   including whether either side is optional.
4. **Which tables we own** and which belong to another system.
5. **What is deliberately out of scope** (audit tables, logging, anything the feature does not
   touch).

Anything the source does not say, **ask**: *can an application exist without a customer?* ·
*can one customer have two open applications at once?* · *who owns that table?*

### Phase 2 — Ask the one question that changes the drawing

**Is this the model as it IS, or as it WILL BE?** An as-is ERD drawn from the live schema and
a to-be ERD drawn from the spec are different documents with different readers, and putting
them on one canvas has confused every team that has tried. Say which in the `subtitle`.

### Phase 3 — Check, then draw, in one call

Call `figma_diagram` with `type: "erd"` and `options: { checkFirst: true }`: it checks the model and
**draws only if there are no findings**. Dirty → `checkedOnly: true` + the findings and nothing
is drawn; clean → it draws and returns `audit` in the same call. (`options: { dryRun: true }`
is still there for iterating on a model you expect to be wrong.)

Read every warning. The ones specific to this kind:

| Warning | What it usually means |
|---|---|
| Table with no primary key | a real gap, or the table is `external` and you did not say so |
| Relationship names a column that does not exist | a typo, or the column has not been added yet |
| Many-to-many with no join table | a decision nobody has made — make it now |
| Type mismatch across a key | it works until the data grows |
| Relationship with no column named | fill in `fromField`/`toField` |
| Orphan table | why is it here? |
| snake_case mixed with camelCase | two people's work, unreconciled |

Fix the model, re-dry-run, then draw.

### Phase 4 — Draw, verify, report

1. Place the frame clear of what is on the page (shared rules §7).
2. Draw.
3. Read `audit` from the same result — it is the render-side check (overflow, clipping,
   truncation). Fix anything it reports. No second call for it.
4. One `screenshot` per SET of diagrams at the end, not one per frame — skip it when
   `audit` is clean and the human is watching Figma live.
5. Report per shared rules §11.

## What the machine does NOT check

- whether the model matches the **live database** — it only checks the model against itself;
- whether the cardinality is true in practice (the checker cannot know that one customer has
  had two open applications since 2023);
- whether a missing index or a bad type will actually hurt;
- whether the feature needs a table it does not have.

If correctness against the real schema matters, read the schema and diff it yourself. Say in
the summary which source you drew from — that one sentence is what stops this diagram being
mistaken for the truth six months from now.
