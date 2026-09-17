export const SITEMAP = `# Sitemap — figma_diagram type:"sitemap"

What the product is MADE OF: every page, and which page contains which. Reach
for it before drawing screens, because "which screens exist" is the question a
screen-drawing session assumes an answer to and almost never has one for.

**The one thing to get right about this kind:** its edges are **containment**,
not navigation.

| relation | meaning | tool |
| --- | --- | --- |
| A contains B | B lives under A in the product | \`type:"sitemap"\` |
| A → B | the user went from A to B | \`type:"userflow"\` |

They are different relations over the same boxes, and a sitemap drawn as a
second userflow is the commonest way this kind gets wasted. So there is
**no \`edges\` array** and no arrow token in the compact form: containment is a
\`parent\` on the page itself, and the drawn lines have no arrow heads. If you
find yourself wanting an arrow, what you want is a userflow.

Pick the diagram by the question:

| question | tool |
| --- | --- |
| what pages exist, and where does each live | \`figma_diagram\` type:"sitemap" |
| what does the user see next | \`figma_diagram\` type:"userflow" |
| who does each step | \`figma_diagram\` type:"activity" |
| what do we store | \`figma_diagram\` type:"erd" |

## Shape

\`\`\`json
{
  "type": "sitemap",
  "title": "CRM · kiến trúc thông tin",
  "x": 0, "y": 0,
  "pages": [
    { "id": "crm", "label": "CRM" },
    { "id": "dash", "label": "Dashboard", "parent": "crm", "screenId": "dashboard" },
    { "id": "list", "label": "Danh sách", "parent": "crm",
      "screenId": ["contacts-list", "contacts-empty"] },
    { "id": "contacts", "label": "Liên hệ", "parent": "crm" },
    { "id": "detail", "label": "Chi tiết liên hệ", "parent": "contacts",
      "detail": "chỉ chủ sở hữu xem được" },
    { "id": "reports", "label": "Báo cáo", "kind": "section", "parent": "crm" },
    { "id": "revenue", "label": "Doanh thu", "parent": "reports" },
    { "id": "activity", "label": "Hoạt động", "parent": "reports" },
    { "id": "psp", "label": "Cổng thanh toán", "kind": "external", "parent": "crm" }
  ],
  "options": { "rankdir": "TB" }
}
\`\`\`

### \`pages[]\`

| field | meaning |
| --- | --- |
| \`id\` | the handle. No whitespace — the drawn layer is named with it |
| \`label\` | the page's name **as a user sees it in the nav** |
| \`parent\` | the page this one **lives under**. Omit on the root. NOT the page you came from |
| \`kind\` | \`page\` (default) · \`section\` · \`modal\` · \`external\` |
| \`detail\` | anything else a reader needs: who can see it, what is on it |
| \`screenId\` | the artboard(s) this page is designed as: one id, or a LIST. A page is usually SEVERAL — itself plus its states |
| \`cls\` | \`happy\` · \`error\` · \`edge\` · \`plain\` — colour by meaning |

### The four kinds, and why they are not decoration

| kind | what it means | what it changes |
| --- | --- | --- |
| \`page\` | a real page with content of its own | nothing |
| \`section\` | a nav **heading** with no page behind it | a section of fewer than two children is reported — a grouping of one thing is a level the user clicks through for nothing |
| \`modal\` | a dialog / sheet / drawer | exempt from the depth rule: it opens on top of a page rather than being another click in |
| \`external\` | not ours to design (a gateway, a help centre elsewhere) | drawn dashed; pages **inside** it are reported |

### \`options\`

| option | default | meaning |
| --- | --- | --- |
| \`rankdir\` | \`TB\` | \`TB\` is the org-chart tree; \`LR\` runs it rightwards, which reads better past three levels |
| \`layout\` | \`tree\` | \`tree\` is the tidy-tree pass; \`dagre\` packs an irregular tree differently but may reorder siblings |
| \`maxDepth\` | \`4\` | levels allowed before depth is reported, counting the root as 1 |
| \`colorByTarget\` | \`true\` | tint a line when the page it leads to is \`error\` or \`edge\` |
| \`liveRoute\` | \`true\` | dragging a page re-routes the lines touching it |

## Write it in the compact form

\`text\` instead of \`pages\`, at roughly a third of the tokens. **Indentation is
the model** — the same shape the nav has on the page and a folder tree has on
disk:

\`\`\`
crm "CRM"
  dash "Dashboard" screen:dashboard
  contacts "Liên hệ"
    list "Danh sách" screen:contacts-list,contacts-empty
    detail "Chi tiết liên hệ" screen:contact-detail / chỉ chủ sở hữu xem được
  reports "Báo cáo" section
    revenue "Doanh thu"
    activity "Hoạt động nhân viên"
  psp "Cổng thanh toán" external
\`\`\`

Line grammar: \`id ["Label"] [kind] [cls] [screen:<a>,<b>,…] [/ detail]\`

- **Indent deeper = child. Back to a column already in use = sibling.** Two
  spaces, four or a tab, as long as you are consistent — an indent that lines
  up with no level in use is reported rather than filed under a guess.
- \`screen:\` and not \`@\`: \`@name\` is a policy reference everywhere in this
  repo, and one sigil with two meanings is a poor trade in the one grammar
  where the reader is already counting spaces.
- **\`screen:01,02,06\` — a page is usually several artboards.** The first is the
  page itself; the rest are its states. A list page and its empty state are ONE
  page in two states, not two pages, and writing both down is what lets the
  coverage check below ask "which artboards have no home?" without it firing on
  every empty state ever designed.
- **There is no arrow.** \`a -> b\` is reported, with what to do instead.
- \`#\` comments. A page declared twice is reported — a page appears ONCE in a
  containment tree, and one genuinely reachable from two places is navigation.

## What it tells you

Findings about the MODEL, before anything is drawn:

| finding | why it matters |
| --- | --- |
| a page whose \`parent\` does not exist | the commonest typo in a hand-written tree, and it takes the page's whole subtree with it. Dropped, with the count |
| a containment cycle | a is under b and b is under a. No tree can hold it; dropped |
| more than one page with no parent | a sitemap has one front door. Still drawn, side by side, so you can see what is loose |
| deeper than \`maxDepth\` | the middle levels may be doing no work, or the page needs reaching another way (search, a nav shortcut) |
| a \`section\` with fewer than two children | a category of one thing is not a category |
| two siblings with the same label | they sit in the same menu, so a user cannot tell them apart |
| a flat list with no parents anywhere | a list of pages is a list, not an architecture |
| an \`external\` page with pages inside it | if we own what is under it, it is not external |
| one artboard claimed by two pages | "which page is this screen on?" has two answers while both drawings look right |

**Quiet on purpose**, so that the findings above are worth reading:

- a **\`page\`** with a single child — "Liên hệ → Chi tiết liên hệ" is what
  correct IA looks like. Only a \`section\` is checked for it.
- the same label under **different** parents — "Cài đặt" under Quản trị and
  under Hồ sơ are two menus, not a clash.
- a \`modal\` at any depth.

## The cross-check with the flows

This is the kind that can disagree with \`type:"userflow"\`, and the reason to
draw both. Put them on one page and \`consistency\` reports, as \`ia-drift\`:

- **a screen the flow walks through that no sitemap has a page for** — either
  the IA is missing it or the flow named a screen that does not exist;
- **one screen under two ids** — the flow calls it \`contact_detail\` and the
  sitemap calls it \`detail\`. Both drawings look right and nothing downstream
  can tell they are the same page.

Matching is by id, then by \`screenId\`, then by label — so a flow and a sitemap
may deliberately use different ids as long as one of them names the artboard.

**The reverse is NOT checked**, deliberately: a page no flow reaches is not a
finding. A userflow draws ONE journey through the product, so on any real IA
most pages are not on it, and reporting them would put a dozen true and
useless lines on every page holding both kinds.

## Does the IA match the designs? — \`coverage\`

A fourth field, beside the three that already come back:

| field | the question |
| --- | --- |
| \`warnings\` | is this a legal diagram of its kind |
| \`audit\` | did the drawing overflow, clip or truncate |
| \`consistency\` | do the diagrams contradict each other |
| \`coverage\` | does the IA match the ARTBOARDS on the canvas |

\`\`\`
coverage: {
  undesigned: [{ page: "Báo cáo", wanted: ["13"], … }],   // no artboard yet
  orphans:    [{ name: "14 · export-csv", … }],           // belongs to no page
  stats:      { pages: 8, designed: 6, artboards: 13, claimed: 12 },
}
\`\`\`

It comes back with a sitemap draw (the artboard names ride along with the
drawing, so it costs no round trip) and from \`figma_read op:"get_page_model"\`,
which is the call to make when you have changed something and want everything
re-checked **without drawing**.

**It is not a warning**, deliberately. A page with no design yet is a fact
about a project in progress, not a defect in the model, and reporting it as a
finding would train people to ignore findings.

**Silent until you use \`screenId\`.** An IA drawn before a single screen
exists would otherwise report every page as undesigned, every time.

## Layout

The only kind here that does not go through dagre by default. A tree has zero
edge crossings by construction, so dagre has nothing to optimise — and its
ordering pass would **reorder siblings**, which in an IA is the nav order and
therefore content. \`tree\` (Buchheim/Walker's tidy tree) centres every parent
over its children, keeps the order you wrote, and tucks a narrow branch under
a wide one. \`options.layout: "dagre"\` is there for anyone who prefers its
packing.

Box widths are uniform: a sitemap is read as a menu, and ragged widths make a
level look like a hierarchy it is not.

Dragging a page re-routes the lines touching it, live. Dragging the END of a
containment line does **not** reconnect it the way an arrow's end does — that
would mean "this page now lives somewhere else", which is a change to the
model, so the line is put back where the boxes say it goes. To move a page in
the tree, patch its \`parent\`:

\`\`\`
figma_diagram({ update: "140:5914", patch: [
  { collection: "pages", id: "billing", set: { parent: "settings" } },
] })
\`\`\`
`;
