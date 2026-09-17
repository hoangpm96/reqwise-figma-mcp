---
name: figma-sitemap
description: Draw the information architecture of a product on Figma — every page, and which page contains which. Reach for it BEFORE drawing screens, and to cross-check a userflow against the pages that actually exist.
allowed-tools: Read, Glob, Grep, AskUserQuestion, mcp__reqwise-figma__figma_status, mcp__reqwise-figma__figma_docs, mcp__reqwise-figma__figma_read, mcp__reqwise-figma__figma_diagram, mcp__reqwise-figma__figma_write
user-invocable: true
argument-hint: "<product or area> [source file or @tag]"
---

# /figma-sitemap — What the product is made of

Read `../reqwise-diagram-rules.md` first — connection gate, the four levels of correct, the
findings loop, frame placement, verification. This file carries only what is specific to a
sitemap.

## Goal

Answer the question a screen-drawing session assumes an answer to and almost never has one
for: **which pages exist, and where does each one live?** A spec names screens as it happens
to need them; nothing in it says whether "Chi tiết liên hệ" is under "Liên hệ" or beside it,
or whether "Báo cáo" is a page or just a menu heading.

Output: one Figma frame `Sitemap · <title>`, plus the IA questions the tree exposed — and, if
a userflow is on the same page, the screens the flow walks through that the architecture has
no page for.

## Constraints

### Hard rules — never violate

- **An edge is CONTAINMENT, not navigation.** `parent` means "this page lives under that
  one". It does **not** mean "the user came from there". This is the rule the whole kind
  rests on, and the tool enforces it structurally: there is no `edges` array, no arrow token
  in the compact form, and no arrow heads on the drawn lines. If you want an arrow, you want
  `/figma-userflow` — a different diagram, drawn separately.
- **One page appears ONCE.** A tree has one parent per node. A page genuinely reachable from
  two places is navigation, and belongs in a flow; the tool drops the second declaration and
  says so.
- **Use the user's words for `label`.** It is the word in the nav, not the route or the
  component name. `contacts-list` is an `id`; "Danh sách liên hệ" is a label.
- **`section` only for a heading with no page behind it.** If clicking it shows something,
  it is a `page` with children.
- **Never invent a page to fill a gap in the tree.** A branch with one child is a finding
  about the IA, not a missing box.

### Write it in the compact form

`text` instead of `pages`, at roughly a third of the tokens. **Indentation is the model** —
the same shape the nav has on screen and a folder tree has on disk, so the thing that says
"contains" is the thing every reader already uses to say it:

```
crm "CRM"
  dash "Dashboard" screen:dashboard
  contacts "Liên hệ"
    list "Danh sách liên hệ" screen:contacts-list,contacts-empty
    detail "Chi tiết liên hệ" screen:contact-detail / chỉ chủ sở hữu xem được
    importer "Nhập từ CSV" screen:contacts-import
  deals "Cơ hội"
    board "Bảng kanban" screen:deals-board
    lost "Đã mất" edge
  reports "Báo cáo" section          # a heading, no page of its own
    revenue "Doanh thu"
    activity "Hoạt động nhân viên"
  settings "Cài đặt"
    team "Thành viên"
    billing "Thanh toán"
      psp "Cổng thanh toán" external  # not ours to design
    delete "Xoá workspace" modal err
```

Line grammar: `id ["Label"] [kind] [cls] [screen:<a>,<b>,…] [/ detail]`

- Two spaces, four, or a tab — as long as you are consistent. An indent that lines up with no
  level in use is **reported**, not filed under the nearest guess.
- `screen:` and not `@`: `@name` is a policy reference everywhere in this kit.
- **`screen:01,02` — a page is usually SEVERAL artboards.** First is the page,
  the rest are its states. List them all: it is what turns "which artboards
  have no home in the IA?" into a question worth asking instead of one that
  fires on every empty state.
- `#` comments. `a -> b` is reported, with what to do instead.

### The containment table — read this before writing a single line

The habit is a decade of flowcharts, so the wrong answer is the familiar one.

| Want to say | Write | NOT |
|---|---|---|
| The contact detail page lives inside Contacts | `detail` indented under `contacts` | `contacts -> detail`, which is a flow |
| After saving, the user lands on the list | nothing — draw it in `/figma-userflow` | a sitemap line; a sitemap has no "after" |
| Reports is just a menu heading | `reports "Báo cáo" section` | a plain page, which hides that nothing is behind it |
| The delete confirmation is a dialog | `delete "Xoá" modal` | a page — it would count as a level deep |
| Checkout leaves for the gateway's own pages | `psp "Cổng thanh toán" external` | a page of ours, which claims we design it |
| This page is the artboard `contact-detail` | `screen:contact-detail` | nothing, which costs the cross-check its match |
| The list page and its empty state | `screen:01,02` on ONE page | two pages — an empty state is not somewhere you navigate to |
| The same page is reachable from two menus | pick its **home**, and draw the other route as a flow | declaring it twice |

### Pitfalls — easy to get wrong

- **A route is not an IA.** `/settings/billing/invoices` is one URL; whether invoices is a
  page, a tab or a section of the billing page is the question you are here to answer. Do not
  transcribe the router.
- **Tabs are usually not levels.** If a tab does not change what the nav highlights, it is
  content on one page. Modelling every tab as a child is how a three-level product measures
  five deep.
- **A `page` with one child is fine.** "Liên hệ → Chi tiết liên hệ" is correct IA and the
  tool is silent about it. Only a `section` of fewer than two is reported.
- **Depth is about clicks, not neatness.** The default `maxDepth` is 4 — root plus three
  clicks. If the IA is deliberately deeper (a documentation tree, a product catalogue), say so
  with `options: { maxDepth: 5 }` rather than flattening a tree that is right.
- **Do not draw states.** "Danh sách rỗng" is an empty state of the list page, not a page.
  It belongs to the screen work, or to `/figma-userflow`.

## Inputs

```
/figma-sitemap "CRM"                          # interview from scratch
/figma-sitemap "CRM" @docs/srs/spec.md        # derive from a source, ask only the gaps
/figma-sitemap                                # asks which product or area
```

Any source works: an SRS feature list, a nav mock, a route file, a screen inventory. Read what
there is; never require it.

## Approach

### Phase 0 — Connection

Per shared rules §5.

### Phase 1 — Read what the file already knows

A sitemap is the one kind worth drawing **after** looking at the page, because a userflow
already on it is a partial answer:

```
figma_read op:"get_page_model"
```

Any `Userflow · ` frame there names screens somebody has already decided exist. Those are
candidate pages — and after you draw, the tool will tell you which of them your tree missed.

### Phase 2 — Derive the model, and name the gaps

Build the **fact-list** you will check the drawing against:

1. **Every page the source names**, with the word the user sees.
2. **For each one: what contains it.** This is the part no spec states.
3. **Which of them are headings** with nothing behind them.
4. **Which are dialogs**, not pages.
5. **Which leave the product** (gateways, help centres, status pages).
6. **Which artboards each page is** (`screenId`) — the page itself *and its
   states*, where they exist. A list page plus its empty state is `screen:01,02`.

Anything the source does not say, **ask**, in the user's language: *where does someone find
this from the front page?* · *is "Báo cáo" a page, or just a menu?* · *does this open on top
of what you were doing, or take you away from it?*

### Phase 3 — Ask the one question that changes the drawing

**Which way should it read: `rankdir: "TB"` (the org-chart tree, the default) or `"LR"`
(rightwards)?** Past three levels a TB tree gets too wide to read or print, and LR is the
answer; under that, TB is what everybody expects a sitemap to look like. It costs nothing to
ask and it changes the whole shape.

### Phase 4 — Check, then draw, in one call

Call `figma_diagram` with `type: "sitemap"` and `options: { checkFirst: true }`: it checks the
tree and **draws only if there are no findings**. Dirty → `checkedOnly: true` + the findings
and nothing is drawn; clean → it draws and returns `audit` in the same call.

Read every warning. The ones specific to this kind:

| Warning | What it usually means |
|---|---|
| Dropped, because nothing contains it | a typo in a `parent` — and it took the page's whole subtree with it. Check the count in `stats.pages` |
| Containment cycle | two pages each claim to be inside the other; one belongs higher up |
| N pages with no parent | a second front door, or branches not yet attached. Drawn side by side so you can see what is loose |
| N pages are 5+ levels deep | either the middle levels do no work, or those pages need reaching another way (search, a nav shortcut) |
| Section that groups fewer than two pages | a category of one thing is a level the user clicks through for nothing |
| Two pages under X are both called Y | same menu, indistinguishable to a user — or the same page written twice |
| No page contains another | a flat list is a list, not an architecture |
| External page with pages inside | if we own what is under it, it is not external |

Then read `coverage` — the answer to "how far along is the design?", read
against the structure of the product rather than a list of file names:

| field | what to do with it |
|---|---|
| `undesigned` | pages whose artboards are not on the canvas. Progress, not a defect — report it, do not "fix" it |
| `orphans` | artboards no page claims. Either a screen with no home in the IA, or a state you forgot to list on its page |
| `stats` | `6/8 pages have a design` — the one line worth saying out loud |

An `orphan` is the one to look at twice: nine times in ten it is a **state** of
a page somebody already drew (an empty list, a validation error, a loading
frame), and the fix is to add it to that page's `screen:` list — not to invent
a page for it.

Then read `consistency`. `ia-drift` is what this kind exists for:

- **a screen the flow walks through that no sitemap has a page for** — either your tree is
  missing it, or the flow named a screen that does not exist. Both are findings; decide which
  with the user, do not quietly add a box.
- **one screen under two ids** — the flow says `contact_detail`, the sitemap says `detail`.
  Both drawings look right and nothing downstream can tell they are one page. Give them one
  id, or point the flow's `screenId` at the page.

The reverse is **not** reported, deliberately: a page no flow reaches is expected, because a
userflow draws one journey through the product. Do not treat its absence as a clean bill for
the pages nobody has a flow for — that is yours to notice, in Phase 5.

### Phase 5 — Draw, verify, report

1. Place the frame clear of what is on the page (shared rules §7).
2. Draw.
3. Read `audit` from the same result — the render-side check (overflow, clipping, truncation).
   Fix anything it reports. No second call for it.
4. One `screenshot` per SET of diagrams at the end, not one per frame — skip it when `audit`
   is clean and the human is watching Figma live.
5. Report per shared rules §11. Add the two things only you can say: which pages came from the
   source and which came from an answer in the interview, and **which pages no flow on the
   page reaches** — the tool will not tell you, and it is the list worth reading aloud.

To move a page in the tree later, patch its parent rather than redrawing:

```
figma_diagram({ update: "140:5914", patch: [
  { collection: "pages", id: "billing", set: { parent: "settings" } },
] })
```

Dragging a page on the canvas re-routes its lines live. Dragging the **end** of a containment
line does not reconnect it the way an arrow's end does — that would mean the page now lives
somewhere else, which is a change to the model, so the line goes back on the boxes.

## What the machine does NOT check

- whether these are the **real** pages — the checker cannot know about the admin screen nobody
  documented, or the page that exists only in staging;
- whether the grouping matches how users actually think. A tree can be perfectly well-formed
  and still put "Hoá đơn" somewhere nobody looks; that is what a tree test or a card sort is
  for, and this diagram is the thing you would test;
- whether a `label` is the word users use, only that two siblings do not share it;
- whether an artboard is *finished* — `coverage` knows a frame with that name
  exists, not whether anything is on it;
- whether a page earns its place. A tidy IA of pages nobody needs is still the wrong product.
