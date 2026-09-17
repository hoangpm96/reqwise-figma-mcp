# Reqwise diagram rules — shared by every `/figma-*` diagram skill

> SKILL.md carries only what is genuinely its own.

## 1. You supply the model. The tool supplies the drawing.

These tools do not read your spec and they do not invent content. You derive the model —
which screens exist, who the actors are, what each transition is triggered by — and the tool
lays it out, draws it, and tells you what is missing from the model you gave it.

So the failure mode is not "the picture is ugly". It is **a confident picture of something
nobody said**. Two rules follow:

- **Never fill a field to make a warning go away.** If the spec does not say what triggers a
  transition, the answer is to ask, not to write `event: "Submit"` because it sounds right.
- **An empty answer is a finding.** No error path in the spec means the spec has no error
  path — draw what there is and say so, rather than inventing a plausible one.

## 1b. Reading the shape costs tokens too

The tool definition already carries a one-line field list per property, so most of the time you
can write the call without reading anything. When you do need the shape:

- `figma_docs({ section: "<kind>", level: "cheat" })` — the call shape and the field tables,
  roughly half the full section. Enough to write the call.
- `figma_docs({ section: "<kind>" })` — the full section: the findings this kind reports, the
  notation traps, the layout notes. Read it the first time you draw this kind, or when a
  warning needs explaining.

One read per kind per session, not one per diagram.

## 1c. Write the model in the COMPACT form

Every `figma_diagram` kind takes `text` — one line per thing — **instead of** the arrays, at
roughly a third of the tokens. It is the default way to write a model now, and the per-kind
`SKILL.md` gives you that kind's lines.

Three things it buys beyond the token count:

- **The ids that exist only to be referenced are generated for you.** A sequence message no
  longer needs an `id`, and a fragment no longer carries a hand-maintained
  `messages: ["m3","m4"]` list — a block's extent is simply where it is written. That list was
  both a third of the payload and the part that silently drifted the moment a message moved.
- **The shape of a line is the meaning.** `u ->> api` is a call and `api -->> u` is a reply;
  `a > b` is flow and `a ~> b` is rework. Writing the wrong one is visible on the page in a way
  that `kind: "return"` buried in an object is not.
- **Diffs read.** A model in `text` can be pasted into a spec, reviewed in a PR, and edited by
  a person who has never seen this tool.

Rules:

- **`text` wins over the arrays** if you send both — and the tool says which won. Do not send
  both; pick one.
- **Comment with `#`.** Use it to leave the source's own wording beside a line you paraphrased.
- **The arrays are still there** for the cases the compact form cannot say (an explicit
  `fromSide`/`toAt` to pull two crossing lines apart). Mixing is fine *across* diagrams, not
  within one.
- **`type:"userflow"` is the exception**: its compact form is `mermaid` (a `flowchart TD`
  source), not `text`. Same idea, different notation, because a flowchart already has one
  everybody knows.
- **`type:"sitemap"` has no arrow at all.** Its `text` form is INDENTATION, because its edges
  are containment ("this page lives under that one") rather than navigation. `a -> b` there is
  reported, not drawn — if you want an arrow between screens, that is a userflow.

## 2. Five levels of "correct" — never collapse them into one PASS

| Level | What it checks | Who checks it |
|---|---|---|
| 1. **Call shape** | Field names, types, enums | the server's schema — you get `INVALID_PARAMS` with a `hint` |
| 2. **Rendering** | Does anything overflow, clip, or truncate on the canvas | `figma_read` op `layout_audit` — structural facts, not pixels |
| 3. **Notation** | Is this a legal *diagram of this kind* | the tool's `warnings` (and for a use case diagram, dropped links) |
| 4. **Agreement** | Does it contradict the diagrams already on the page | the draw result's `consistency` |
| 5. **Business truth** | Does it match the real process and the source document | **nothing checks this. You do, against a fact-list.** |

A drawing that returns no findings has passed 1–4. It has said **nothing** about level 5.
Report the levels separately; "✅ drawn, no warnings" read as "the diagram is right" is exactly
how a wrong diagram gets signed off.

## 3. The findings are the deliverable, not a nuisance

Every kind returns `warnings` about the MODEL — a use case nobody can start, a state nothing
can leave, a call nobody answers. These are the questions the spec left open. The whole point
of drawing on a canvas rather than writing prose is that they become visible.

**A diagram whose `warnings` you did not read and act on is not finished.** For each warning,
do exactly one of:

- **fix the model** and redraw (the usual case — you mis-derived something);
- **ask the user** — the spec genuinely does not say;
- **explain why it is fine** in your summary — the warning has a reason to be there and you
  are overriding it deliberately.

Never silently drop one.

**Also compare the counts.** `stats` tells you what was actually drawn. If you sent 12 links
and `stats.links` is 11, something was **dropped** as not-a-legal-thing — find it before you
tell anyone the diagram is done.

## 4. Rules that fight a strong habit have to be checked, not just read

The reason each SKILL.md carries a **DO / DON'T table** rather than a paragraph: where the
correct way is the opposite of the familiar way, prose loses to habit — yours and the model's.
`-->` is the commonest edge token in every other diagram language, so it gets written into a
use case diagram where the correct edge is a plain undirected line.

For these tools that check is server-side and already runs: an `include` touching an actor is
dropped, an activation bar is derived rather than declared, a fragment that skips a message is
refused. Your job is to **read what came back** (rule 3), not to re-derive the rule from memory.

## 5. Before anything else: is the write path open?

1. Call `figma_status`.
2. Read `mode` **before** `pluginConnected`.
3. `pluginConnected` is **tri-state**: `true`/`false` are measured; **`null` means unknown** —
   this process is a follower that could not query the leader (see `statusSource` /
   `statusError`). **Do not treat `null` as disconnected** and do not send the user to reopen
   the plugin on the strength of it; operations may be forwarding perfectly well.
4. Unsure → read something small (`figma_read` op `get_design_context`). A successful op is
   proof; a status field is a hint. **A dry run is NOT a probe** — it returns before the create
   op is dispatched, so it never touches the plugin and proves nothing about the write path.
5. Read the `hints` array — it is ordered and names the next concrete step.
6. **Once per session, not once per diagram.** The bridge does not close between two draws;
   re-probing before every frame buys nothing and costs a round trip.

If several Figma windows are connected, `figma_status` lists them: ask which file, then pass
that `channel` on every call. Without it the op lands non-deterministically.

## 6. One call: proof-read, draw, verify

`options.checkFirst: true` runs the checker and the layout first and **draws only if the model
came back clean**. Dirty → nothing is drawn and you get `checkedOnly: true` plus the findings,
which is the dry run you wanted; clean → it draws, in the same call. That is the default way to
draw a non-trivial model.

`options.dryRun: true` still exists for iterating on a model you expect to be wrong (it returns
`warnings` + `stats` + the frame size and draws nothing). Use it while you are still arguing
with the spec; use `checkFirst` when you think you are done.

`options.verify` is **on by default**: the result carries an `audit` field — the render-side
check on the frame just drawn — so verification is not a round trip either. See §8.

Three calls became one. The server side of all three is milliseconds; the round trips were the
expensive part.

## 7. Where the frame goes

- `x` / `y` place the frame on the page. **Set them.** Everything defaults to `0,0`, and a
  working file usually has a screen sitting at its origin.
- **A new frame is never drawn on top of existing work.** If the spot you asked for is taken,
  the frame slides straight DOWN until it is clear, keeping your `x`, and a warning names what
  was in the way and where it went instead. So a forgotten `x`/`y` costs you a warning and a
  scroll, not somebody's artwork hidden under a diagram. It is still worth placing the frame
  yourself: sliding down is a safety net, not a layout.
- Before the first draw, look at what is already there (`figma_read` op `get_design_context`,
  or `search_nodes` for existing `Userflow · ` / `Activity · ` / `ERD · ` / `Sequence · ` /
  `Sitemap · ` / `State · ` frames) and place the new one
  clear of it.
- **Redrawing in place is exempt.** A frame reopened with `into` keeps exactly where the user
  dragged it — it is already "existing work", and moving it would be the bug this rule
  prevents, not the fix.
- **A set of diagrams belongs in ONE call.** `figma_diagram({ diagrams: [...], place: "column",
  x, y })` draws them all and stacks them for you — the sizes are known before anything is
  drawn, so you never compute `previous y + height + 250` by hand (and two frames never land
  on top of each other at 0,0). `place: "row"` lays them out sideways, `"none"` keeps each
  entry's own `x`/`y`; an explicit `x`/`y` on an entry always wins. Findings come back per
  entry, prefixed with its title, and with `options: { checkFirst: true }` the WHOLE set is
  proof-read and nothing is drawn if any entry has findings. If a draw fails mid-set you get
  `failedAt` and the list of frames that did land.
- Drawing them one by one is still fine for a single diagram; the result returns `box`, so you
  know the height.
- `parentId` puts the frame inside an existing frame or section instead of on the page.
- **A page of its own is something to ASK FOR before you draw, never to reach for mid-draw.**
  Figma's Starter plan caps a file at **three pages**, so `createPage` is not a thing that
  usually works and occasionally fails — on a free file it is a thing that reliably throws, and
  every real file gets there. A tool that tries it and falls back lands the output on
  `figma.currentPage`, which is whatever the user happens to have open: that is how a generator
  put four pages of content onto somebody's working screens tonight. So check the page count
  FIRST (`figma_read` op `get_document_info` lists them), decide with that number in hand, and
  tell the user which page the work is going to and why. "I could not make a page, so I used
  the one you were looking at" is not a recovery; it is the accident, reported after the fact.

## 8. Verify with data, then show a picture

1. The draw result already carries `audit` (unless you passed `verify: false`) — the
   render-side facts: **overflow, clipping, truncation**. Fix anything it reports.
   `warnings`, `audit` and `consistency` answer three different questions: `warnings` is the
   MODEL (semantic, checked before drawing), `audit` is the DRAWING (structural, measured
   after), `consistency` is the PAGE (does this contradict its neighbours). Read all three.
2. Call `figma_read` op `layout_audit` by hand only when you need it again — after a
   `figma_write` edit, or on a frame somebody rearranged.
3. **One screenshot per SET of diagrams, at the end** — not one per frame. It is by far the
   biggest response in the pipeline (~100KB of base64 for one frame) and the human is looking
   at the actual canvas anyway. Skip it entirely when `audit` is clean and the human is
   watching Figma live.

Never screenshot instead of reading `audit`. "The screenshot looks fine" has missed a clipped
label in every project that has tried it.

## 9. Redrawing, and what the user changed by hand

To change a diagram already on the canvas, pass **`update: <frameId>`**. The frame keeps its
id, so every comment pinned to it, every prototype link into it, and wherever the user dragged
it all survive. Never draw a second frame and delete the first — that throws those away.

Better still, when you are changing part of a diagram: the frame **remembers the model it was
drawn from**, so send only the change.

```
figma_diagram({ update: "140:5914", patch: [
  { collection: "messages", id: "m7", set: { label: "200 { ticketId }" } },
  { collection: "messages", where: { from: "api", to: "psp" }, set: { cls: "error" } },
] })
```

- Select a member by `id`; by `where: { from, to }` where the collection has no ids (activity
  `edges`, erd `relations`, state `transitions`); or by `at: <index>`.
- `{ collection, add: {...}, after? }` inserts, `{ collection, remove: id }` drops,
  and `{ set: {...} }` with no collection changes the diagram itself (title, system, options).
- A patch carries **no model fields** in the same call — the frame is the source. Read what is
  there with `figma_read` op `get_diagram_spec` if you need to look first.
- The result is checked and laid out like any other spec: a patch is a cheaper way to SEND a
  model, never a way past the findings.

Roughly a third of what an agent emits is a spec it has already emitted. On a 30-message
sequence diagram, changing one label costs **175 bytes as a patch against 2,052 as a redraw**.

A `diagrams: [...]` set takes `update` per entry, so re-running a set updates it in place
instead of drawing every diagram on the page a second time. A redrawn frame keeps where the
user put it and does not take a slot in the placement.

Two things survive on the canvas without a redraw, and you should tell the user they exist:

- **Dragging a shape** re-routes every line touching it, live.
- **Dragging a line's endpoint** onto another face *reconnects* it — the connection point is
  remembered and the line keeps following the shapes.

So the right advice for "this one line looks awkward" is usually *drag its end*, not *redraw
the whole diagram*. If the diagram was rearranged while the plugin was closed,
`figma_write` → `figma.reflowDiagram()` puts the lines back on the shapes.

## 10. When the diagrams disagree with each other

Each frame remembers the model it was drawn from, so a new drawing is compared against every
other diagram on its page — automatically, with no round trip, and with nothing for you to
declare. Disagreements come back as `consistency`:

- **`name-drift`** — one id, two names. `user` is "User" in the sequence and "Khách hàng" in
  the use case diagram. Pick one and `patch` the others.
- **`id-drift`** — one name, two ids. The quiet one: both diagrams look right, but nothing
  downstream can tell they are the same role, so traceability between the views is broken.
- **`lifecycle-drift`** — a state diagram and an ERD `enum(...)` column disagree about what one
  entity can hold. Either the lifecycle draws a status the database rejects, or the database
  allows one the lifecycle can never reach. One of the two is wrong; decide which.
- **`policy-drift`** — two diagrams declare the same rule with different numbers.
- **`ia-drift`** — a userflow walks through a screen no sitemap on the page has a page for,
  or one screen carries two ids in the two views. The reverse is deliberately NOT reported: a
  flow draws one journey, so a page it never visits is the normal case, not a defect.

To get `lifecycle-drift`, write the column as an enum — `status enum(held|paying|paid)!` —
and name the machine after its table ("Booking lifecycle" matches `bookings`). Without the
enum there is nothing to compare and the rule stays silent.

These are **advisory**. A page halfway through being drawn is supposed to disagree with
itself, so nothing is blocked. Report them to the user with the two frames named; do not
"fix" one side on your own guess about which is right.

### Numbers belong to a rule, not to a label

A number written into a label — "Giữ ghế 10 phút", `[n < 3]`, "up to 3 attempts" — is a copy,
and copies drift. Declare it once and reference it:

```
options: { policies: { "hold-minutes": 10, "retry-attempts": 3 } }

"Giữ ghế @hold-minutes phút"       drawn as   "Giữ ghế 10 phút"
"Declined [n < @retry-attempts]"   drawn as   "Declined [n < 3]"
```

The label cannot contradict the rule, because it does not hold the number. The **reference** is
what gets stored on the frame, so:

```
figma_read op:"get_page_model"      →  index.policies:
  { name: "hold-minutes", values: [{ value: 10, frames: ["140:5382", "140:5914"] }], unused: [] }
```

That is the answer to *"we are moving to 15 minutes — what has to change?"*: those frames, and
the change is one patch each. A dotted key changes the rule without resending the rest:

```
figma_diagram({ update: "140:5382", patch: [{ set: { "options.policies.hold-minutes": 15 } }] })
```

`unused` lists frames that declare a rule and never reference it — dead weight, or a label that
was supposed to use it. A reference nothing defines is reported as a normal finding.

`options: { crossCheck: false }` turns it off.

### Ask the file what it already knows

The check that runs on every draw compares against **the same page**, because that costs
nothing — the models come back with the drawing. Diagrams split across pages are not compared
that way.

So in a fresh chat, before drawing into a file you know nothing about:

```
figma_read op:"get_page_model" params:{ scope:"file" }
```

That reads every page — `index` (rules, roles, entities and the frames holding each) plus
`consistency` across the lot, with each frame named `Page › Frame`. It is opt-in and not the
default because reading other pages means loading them, which is slow on a large file. Once
per session, at the start, is the right amount.

Omit `scope` for the current page only, which is free.

## 11. Language, and the font trap

Write the labels in the language of the source document. Vietnamese specs get Vietnamese
labels — do not translate the business's own words into English.

**Inter has no CJK or Hangul glyphs.** A Japanese or Korean label renders **blank** with no
error anywhere on the canvas. The tools warn about this; when they do, pass
`options.font` with a covering family (`"Noto Sans JP"`, `"Noto Sans KR"`) and check it exists
first with `figma_read` op `get_fonts`. Vietnamese is fine in Inter.

## 12. Say what you drew

Close with: the frame name and where it is, the counts from `stats`, **every warning and what
you did about it**, and — separately — the explicit note that business truth (level 4) was not
machine-checked and is the reader's to confirm.
