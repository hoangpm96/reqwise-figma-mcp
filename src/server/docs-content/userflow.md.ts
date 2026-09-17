export const USERFLOW = `# Userflows — \`figma_diagram\` with \`type:"userflow"\`

Draws a user journey: screen boxes, decision diamonds, labelled
arrows, and return paths (cancel / retry / back) routed in side gutters so they
never cross the diagram.

## The division of labour

**You think, the tool draws and proof-reads.** The graph must come from YOUR
reading of the spec / PRD / codebase: which screens exist, what the happy path
is, which errors and edge cases each step can produce, where each branch lands.
The tool never invents a node, never merges branches, never guesses a label. If
the analysis is already written as mermaid, pass it as \`mermaid\` — that is a
shortcut for typing, not a substitute for the analysis.

## Ask before you draw

- Drawing screens for a feature? Ask the user first: *"map the userflow first,
  then draw the UI?"*
- Adding screens to a page that already has a userflow? Ask whether to update
  the flow too. \`create\` warns you which case you are in.

## Shape

\`\`\`js
await figma.userflow({
  title: "Book registration · scan by ISBN",
  subtitle: "feature book-registration",
  x: 80, y: 200,
  nodes: [
    { id: "list",  label: "My books",       kind: "screen",   cls: "happy", screenId: "2.1", slug: "my-books" },
    { id: "scan",  label: "Scan a book\\nISBN field, 13 chars", kind: "screen", cls: "happy", screenId: "2.3", slug: "isbn-scan" },
    { id: "valid", label: "ISBN valid?",    kind: "decision" },
    { id: "err",   label: "E-001 · bad ISBN", kind: "state",  cls: "error" },
    { id: "done",  label: "Book added",     kind: "terminal", cls: "happy" },
  ],
  edges: [
    { from: "list",  to: "scan",  label: "Scan a new book" },
    { from: "scan",  to: "valid" },
    { from: "valid", to: "err",   label: "no" },
    { from: "valid", to: "done",  label: "yes" },
    { from: "err",   to: "scan",  label: "Try again", kind: "return" },
  ],
  options: { linkScreens: true },
});
\`\`\`

Same call as a tool: \`figma_diagram\` with \`type:"userflow"\` and the same fields (plus \`channel\`).

### nodes[]
| field | meaning |
|---|---|
| \`id\` | short key the edges reference |
| \`label\` | box title; a second line (\`\\n\`) becomes the detail line |
| \`detail\` | extra explanatory line |
| \`kind\` | \`screen\` (an artboard) · \`state\` · \`decision\` (a question) · \`external\` / \`terminal\` (legitimate ends) |
| \`cls\` | colour by meaning: \`happy\` green · \`error\` red · \`edge\` amber · \`plain\` white |
| \`screenId\` | the id you will also put in the artboard's name — the back-reference |
| \`slug\` | short human name printed under the title |

### edges[]
\`{ from, to, label?, kind?, fromAt?, toAt? }\`. \`kind:"return"\` marks a
go-back / cancel / retry edge: drawn dashed, routed in an outer gutter, and
kept out of the rank maths so the diagram stays narrow.

\`fromSide\`/\`toSide\` (\`"top"\` | \`"right"\` | \`"bottom"\` | \`"left"\`) pick the
FACE an arrow attaches to, and \`fromAt\`/\`toAt\` (0..1) where along it —
0.5 being the middle. Together they are the declarative version of dragging the
arrow's end: use them to pull two crossing arrows apart, or to make a line
leave the bottom of a box instead of its side. With a side, the edge is drawn
by the generic connector rather than the rank-aware routing. \`fromAt\` alone
slides the port along the face the router chose (for the default \`TB\` that is
horizontal, so 0 is the box's left edge). Both are ignored on a decision
diamond, which attaches at its tip.

### options
| option | effect |
|---|---|
| \`rankdir\` | \`"TB"\` (default) or \`"LR"\` |
| \`colorByTarget\` | arrows take the colour of the node they point at (default true) |
| \`linkScreens\` | wire ON_CLICK → NAVIGATE from each screen box to the artboard whose name contains its \`screenId\`; unmatched ids are reported, never guessed |
| \`font\` | family for every label. Default Inter — which has NO CJK/Hangul glyphs, so a Japanese/Korean flow draws BLANK boxes without e.g. \`"Noto Sans KR"\` here. Check the family exists first with \`figma_read get_fonts\`. |
| \`dryRun\` | check the graph, return warnings + size, draw nothing |
| \`liveRoute\` | keep the arrows attached to the boxes (default true) — see below. \`false\` freezes them exactly as drawn |

## The arrows follow the boxes

Figma Design has no connector object — \`figma.createConnector()\` is FigJam
only — so each arrow is an ordinary vector. To make it behave like a FigJam
connector anyway, the frame remembers its own graph and the plugin re-routes:

- **while the plugin is open**, dragging or resizing a box re-routes every
  arrow that touches it, live (including the return-path gutters and the edge
  labels), and grows the frame if a box is dragged past its edge;
- **deleting a box** hides the arrows that pointed at it (hidden, not deleted,
  so an undo brings them back);
- **with the plugin closed**, nothing follows anything — put a rearranged flow
  right with one call:

\`\`\`js
await figma.reflowDiagram();                    // every userflow on the page
await figma.reflowDiagram({ frameId: flow.frameId });  // or just this one
\`\`\`

**Drag an arrow's end and it RECONNECTS.** Move the head onto another part of
a box — another face, another spot along the same face — and the line is
re-routed to leave and arrive there properly. The connection point is written
into the flow's own graph, so it survives the plugin closing AND the arrow goes
on following its boxes from the point you chose. That is the whole difference
from a frozen line.

An edit that says nothing about attachment — a middle bend nudged, the line
parked somewhere — cannot be read as an instruction, so it is left exactly as
you left it and reported as \`pinned\`. \`figma.reflowDiagram({ force: true })\`
puts everything back under automatic routing, forgetting the points that came
from dragging (a \`fromSide\`/\`toSide\` in the spec survives, because that is
the spec's instruction, not a drag).

The arrow head is a stroke CAP on the line, not a separate triangle, so an edge
is one layer: dragging its end takes the head with it.

The boxes are never moved back: a reflow re-routes the lines to wherever the
boxes now are, it does not re-run the layout. Rank-crossing arrows come back as
plain elbows (out, sidestep halfway, in) rather than with dagre's waypoints —
redraw the flow when you want the tuned layout back.

Renaming a \`flow:<id>\` box layer or an \`edge <id>\` arrow layer breaks the
pairing, and that arrow is then left alone (the reflow op reports it).

## The findings are the point

Every call returns \`warnings\` about the SHAPE of the graph. These are the holes
that stay invisible until the arrows are drawn:

- a \`decision\` with fewer than two ways out — a question with one answer;
- a dead end that is not \`terminal\`/\`external\` — the flow just stops;
- a node unreachable from the start;
- an edge pointing at an id that was never declared (that edge is dropped);
- a \`screen\` with no \`screenId\`/\`slug\` — nothing ties it to a design;
- labels whose characters the chosen font cannot draw (Figma keeps the text and
  renders nothing — a blank box with no error).

Read them, go back to the spec, add the missing case, call again. Use
\`options.dryRun\` to iterate on the graph before anything is drawn.

## mermaid input

\`\`\`js
await figma.userflow({ title: "Checkout", mermaid: \\\`
flowchart TD
  cart["Cart"] --> pay{"Payment ok?"}
  pay -->|"yes"| done(["Order placed"])
  pay -->|"no"| err["E-402 declined"]:::error
  err -.->|"Try another card"| cart
  class cart,done happy
\\\`});
\`\`\`

Understood: \`[box]\` \`{decision}\` \`([terminal])\` \`[[external]]\`, \`-->\`
\`-.->\` (= return) \`==>\`, \`|"label"|\`, chains (\`a --> b --> c\`), inline
\`:::class\` and \`class a,b happy\`. \`classDef\`/\`style\`/\`subgraph\` are ignored —
the palette comes from the class NAME.

## Result

\`{ frameId, name, nodes: { flowId: figmaNodeId }, box, warnings, stats }\` —
\`nodes\` lets you keep working on individual boxes (annotate, recolour, wire
extra prototype links) without searching for them by name.

## Placement

Nothing is auto-placed: pass \`x\`/\`y\` (and \`parentId\` to nest inside a frame or
section). \`stats.w\`/\`stats.h\` come back with the result, so lay the next block
out from the previous one's size instead of stacking everything at (0,0).
`;
