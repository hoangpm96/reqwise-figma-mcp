---
name: figma-userflow
description: Draw a userflow on Figma — screens, decisions, labelled arrows, dashed return paths — when the open question is what the user sees next. Draw it BEFORE the screens, so the holes show up before anyone designs them.
allowed-tools: Read, Glob, Grep, AskUserQuestion, mcp__reqwise-figma__figma_status, mcp__reqwise-figma__figma_docs, mcp__reqwise-figma__figma_read, mcp__reqwise-figma__figma_diagram, mcp__reqwise-figma__figma_write
user-invocable: true
argument-hint: "<the flow> [source file or @tag]"
---

# /figma-userflow — What the user sees next

Read `../reqwise-diagram-rules.md` first — connection gate, the four levels of correct, the
findings loop, frame placement, verification. This file carries only what is specific to a
userflow.

The tool is `figma_diagram` with **`type: "userflow"`**. One thing is different from the
other five kinds: the compact form here is **`mermaid`** (a `flowchart TD` source), not
`text`. Passing `text` to a userflow is an INVALID_PARAMS it cannot explain to you.

## Goal

Map the screens and the paths between them — including the ones nobody wants to think about:
the validation error, the cancel, the back button, the timeout. Drawn *before* the screens,
this is the cheapest place to discover that three error states have no screen and one screen
has no way out.

Output: one Figma frame `Userflow · <title>`, plus the flow holes it exposed.

## Constraints

### Hard rules — never violate

- **Draw the flow before drawing screens**, or at least offer to. A screen designed without
  its flow gets designed twice.
- **Every `decision` needs at least two outgoing edges, each with a `label`** that is the
  condition ("yes" / "no", "còn lượt thử" / "hết lượt"). A question with one answer is not a
  question; the tool reports it.
- **Every path ends** — at a `terminal`, an `external`, or by looping back. A screen with no
  way out is a finding.
- **`kind: "return"` on the edge** for cancel / back / retry. It is drawn dashed in an outer
  gutter and kept out of the rank maths, which is what stops a long flow becoming a spider's
  web.
- **Never invent a screen.** If the spec has no "email already registered" screen, the diagram
  shows the gap. That gap is the deliverable.

### Write it in the compact form — here that is `mermaid`

The five `figma_diagram` kinds take a `text` line-form. **A userflow does not** — its compact
form is `mermaid`, a `flowchart TD` source passed as the `mermaid` field instead of
`nodes`+`edges`. Same idea, different notation, because a flowchart already has one everybody
knows and every model writes fluently.

```
flowchart TD
  list[My books] --> scan[Scan a book]
  scan --> valid{ISBN valid?}
  valid -->|yes| done([Book added])
  valid -->|no| err[E-001 · bad ISBN]
  err -.->|Try again| scan
  class list,scan,done happy
  class err error
```

`[box]` a screen · `{diamond}` a decision · `([rounded])` a terminal · `[[double]]` external ·
`-->` flow · `-.->` a return path · `|"label"|` the edge label · `class a,b happy` the colour.

Use `nodes`+`edges` instead when you need what mermaid cannot say: `screenId` (which is what
links a box to its artboard), `detail` as a second line, or an explicit `fromSide`/`toAt` to
pull two crossing arrows apart. Those are common enough here that the array form is a fair
default for a userflow — unlike the other five kinds, where `text` should be your first choice.

### The node table — read this before writing a single node

| Want to say | Write | NOT |
|---|---|---|
| A screen the user actually sees | `{ kind: "screen" }` (default) | using it for a backend step |
| A question the system asks | `{ kind: "decision" }` with ≥2 labelled edges out | a screen with two arrows |
| A message, toast or inline state — not a full screen | `{ kind: "state" }` | a screen, which implies an artboard someone must design |
| The flow legitimately ends here | `{ kind: "terminal" }` | leaving it dangling |
| It hands off somewhere we do not own | `{ kind: "external" }` | pretending we control it |
| This is the happy path / the failure / the rare case | `cls: "happy"` / `"error"` / `"edge"` | leaving everything `plain`, which makes a long flow unreadable |
| Go back, cancel, retry | `kind: "return"` on the **edge** | a forward edge pointing backwards |

The distinction that matters most is **screen vs state**. Every `screen` is a promise that
somebody will design an artboard for it. Marking a toast as a screen inflates the design
backlog; marking a real screen as a state hides it. Decide deliberately.

### Pitfalls — easy to get wrong

- **`screenId` is what links the flow to the artboards.** Set it (`"2.1"`, `"5.3"`) and
  `options.linkScreens: true` wires ON_CLICK → NAVIGATE from each box to the artboard whose
  name contains that id. Unmatched ids are **reported, never guessed** — read that list.
- **Two lines in a label**: the first is the title, a `\n` starts the detail line. Use it for
  the one fact that makes the box unambiguous ("ISBN field, 13 chars"), not a paragraph.
- **`rankdir: "TB"` is the default** here and is usually right for a flow. `"LR"` suits a
  short, wide journey.
- **A `mermaid` string can replace `nodes`+`edges`** if you already have a `flowchart TD` from
  somewhere — but you own the result either way, so read it before you hand it over.
- **Do not merge branches to tidy the picture.** Two errors that happen to end at the same
  screen are still two edges; collapsing them loses a case.
- **This is not a process diagram.** If the interesting question is *who does this step*, you
  want `/figma-activity`; if it is *what the record can be*, `/figma-state`.

## Inputs

```
/figma-userflow "Đăng ký tài khoản"                    # interview from scratch
/figma-userflow "Vay tín chấp" @docs/srs/spec.md       # derive from a source
/figma-userflow                                         # asks which flow
```

Any source works: a PRD, a spec, an existing wireframe set, or a description. If the workspace
holds wireframes or a screen index, read them — the screen names and ids there are the ones to
reuse.

## Approach

### Phase 0 — Connection

Per shared rules §5.

### Phase 1 — Derive the model, and name the gaps

Build the **fact-list**:

1. **Where the user enters** this flow — every entry point, not just the main one.
2. **The happy path**, screen by screen.
3. **Every decision** the system makes, and every branch out of it.
4. **Every error**: validation, server, permission, not-found — and what the user sees for each.
5. **Every way out**: cancel, back, timeout, "do it later".
6. **Where it ends**, in each case.

Anything the source does not say, **ask**: *what does the user see when the code is wrong?* ·
*can they go back from here?* · *what happens if they close the app halfway?*

The error and exit questions are where this diagram earns its keep — specs almost always have
the happy path and almost never have these.

### Phase 2 — Ask the one question that changes the drawing

**Is this one flow, or several?** "Đăng ký" and "Đăng nhập" and "Quên mật khẩu" are three
flows that share screens; drawn as one graph they produce a picture nobody can follow. Agree
the boundary before drawing, and draw the others separately.

If artboards already exist, also ask whether to wire `linkScreens` — it makes the flow
clickable in Figma's prototype mode, which is what turns it into something a stakeholder can
walk through.

### Phase 3 — Check, then draw, in one call

Call `figma_diagram` with `type: "userflow"` and `options: { checkFirst: true }`: it checks the model and
**draws only if there are no findings**. Dirty → `checkedOnly: true` + the findings and nothing
is drawn; clean → it draws and returns `audit` in the same call. (`options: { dryRun: true }`
is still there for iterating on a model you expect to be wrong.)

Read every warning. The ones specific to this kind:

| Warning | What it usually means |
|---|---|
| Decision with one way out | the other branch has no screen yet — that is the finding |
| Dead end that is not terminal/external | the user gets stuck; what do they see? |
| Unreachable node | nothing leads to it, so either an edge is missing or the screen is not needed |
| Screen with no `screenId` | it will not link to an artboard; fine early, a gap later |
| Unmatched `screenId` on link | the artboard is not drawn yet, or the id does not match its name |

Fix the model, re-dry-run, then draw.

### Phase 4 — Draw, verify, report

1. Place the frame clear of what is on the page (shared rules §7).
2. Draw.
3. Read `audit` from the same result — it is the render-side check (overflow, clipping,
   truncation). Fix anything it reports. No second call for it.
4. One `screenshot` per SET of diagrams at the end, not one per frame — skip it when
   `audit` is clean and the human is watching Figma live.
5. Report per shared rules §11.

Mention the live behaviour: the flow is a working map, not a picture — **drag a box and every
arrow follows it**, and dragging an arrow's end reconnects it. Stakeholders can rearrange it in
the review meeting without breaking it.

## What the machine does NOT check

- whether these are the screens the product actually needs;
- whether the labels match what the UI really says;
- whether an error case exists that nobody in the room has thought of;
- whether the flow is *good* — a reachable, complete, terminating flow can still be six taps
  where two would do.

That last one deserves saying out loud in the summary. This diagram proves the flow is
consistent. Whether it is a flow anyone wants to use is a design conversation, and drawing it
is how you start that conversation, not how you end it.
