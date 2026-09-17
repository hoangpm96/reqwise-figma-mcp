export const ACTIVITY = `# Activity diagrams — \`figma_diagram\` type:"activity"

Draws a business process, with swimlanes or without. With lanes: one band per
owner (role, team, system), the steps inside the band that performs them, and
the handoffs between bands as labelled arrows. Without: the same notation, no
bands.

## When this, and when a userflow

| What the drawing answers | Tool |
|---|---|
| What does the USER see next? | \`figma_diagram\` type:"userflow" |
| WHO does this step, and what gets handed over? | \`figma_diagram\` type:"activity" |

Approval, onboarding, fulfilment, escalation, month-end close — anything that
crosses people. The handoffs between lanes are where real processes lose
things, and they are invisible on a flowchart with no lanes.

## Ask before you draw

**Which way should it run?** \`rankdir: "LR"\` (default) lays the lanes out as
horizontal bands and the process runs left→right — the classic swimlane, and
the better fit for a long process or a wide screen. \`"TB"\` makes the lanes
vertical columns and the process runs downwards — better when there are many
steps per lane, or when it will be read in a portrait document. It changes how
the whole drawing reads, so ask rather than guess.

## The division of labour

**You think, the tool draws and proof-reads.** The steps, their owners, the
decisions, the parallel work and the rework paths come from YOUR reading of the
spec. The tool never invents a step and never guesses an owner: a step whose
\`lane\` does not exist is drawn in a visible "(no lane)" band rather than
quietly filed under the first lane.

## Shape

\`\`\`js
// as a tool call: figma_diagram({ type: "activity", ... })
{
  type: "activity",
  title: "Purchase order approval",
  subtitle: "process PO-01",
  x: 80, y: 200,
  lanes: [
    { id: "req", label: "Requester" },
    { id: "mgr", label: "Manager" },
    { id: "fin", label: "Finance", detail: "SAP" },
  ],
  nodes: [
    { id: "s",      label: "PO needed",          kind: "start",    lane: "req" },
    { id: "draft",  label: "Draft PO",           lane: "req" },
    { id: "review", label: "Review PO",          lane: "mgr" },
    { id: "budget", label: "Within budget?",     kind: "decision", lane: "mgr" },
    { id: "reject", label: "Reject with reason", lane: "mgr", cls: "error" },
    { id: "pay",    label: "Release payment",    lane: "fin", cls: "happy" },
    { id: "done",   label: "PO closed",          kind: "end",      lane: "fin", cls: "happy" },
  ],
  edges: [
    { from: "s",      to: "draft" },
    { from: "draft",  to: "review", label: "submitted PO" },
    { from: "review", to: "budget" },
    { from: "budget", to: "pay",    label: "yes" },
    { from: "budget", to: "reject", label: "no" },
    { from: "pay",    to: "done" },
    { from: "reject", to: "draft",  label: "rework", kind: "return" },
  ],
}
\`\`\`

### lanes[]
\`{ id, label, detail? }\`, drawn in the order given (top to bottom for the
default \`LR\`). One lane per party that DOES something — a lane with no steps
is reported, because either the role does work nobody wrote down or the lane
should go.

**No swimlanes?** Leave \`lanes\` out and leave \`lane\` off every step: you get
a plain activity diagram — same notation (start/end, decisions, fork/join,
rework paths routed outside), no bands, and dagre's own cross positions are
kept because nothing is constraining them any more. The handoff and idle-lane
findings go quiet, since there are no lanes to hand anything over. Use it for a
process one team owns end to end, or when the owners are not the point.

Halfway house: put lane ids on the steps but no \`lanes\` array, and the bands
are derived from those ids in first-appearance order, labelled with the id
(reported, so you can declare \`lanes\` properly when the order or the names
matter).

### nodes[]
| field | meaning |
|---|---|
| \`id\` | short key the edges reference |
| \`label\` | step title; a second line (\`\\n\`) becomes the detail line |
| \`lane\` | the lane that performs this step — required as soon as the diagram has lanes |
| \`kind\` | \`action\` · \`decision\` (needs ≥2 labelled branches) · \`start\`/\`end\` (the trigger and the outcome) · \`fork\`/\`join\` (parallel work, and waiting for it) · \`event\` (something that happens TO the process) · \`external\` (outside the boundary, drawn dashed) |
| \`cls\` | colour by meaning: \`happy\` green · \`error\` red · \`edge\` amber · \`plain\` white |

### edges[]
\`{ from, to, label?, kind?, fromAt?, toAt? }\`. \`kind:"return"\` is a
send-back / rework / retry: dashed and routed outside every lane. **Label every
edge that crosses a lane** with what is handed over ("approved PO", "rejection
reason") — an unlabelled handoff is reported.

\`fromSide\`/\`toSide\` (\`"top"\` | \`"right"\` | \`"bottom"\` | \`"left"\`) pick the
FACE an arrow attaches to, and \`fromAt\`/\`toAt\` (0..1) where along it. They are
the declarative version of dragging the arrow's end — how you pull two crossing
handoffs apart. \`fromAt\` alone slides the port along the face the router chose
(for the default \`LR\` the faces are vertical, so 0 is the top of the box).
Both are ignored on a decision diamond, which attaches at its tip.

### options
| option | effect |
|---|---|
| \`rankdir\` | \`"LR"\` (default) runs the process left→right with horizontal lanes; \`"TB"\` runs it downwards with vertical lanes |
| \`colorByTarget\` | arrows take the colour of the step they point at (default true) |
| \`font\` | family for every label. Default Inter — which has NO CJK/Hangul glyphs, so a Japanese/Korean process draws BLANK boxes without e.g. \`"Noto Sans KR"\` |
| \`liveRoute\` | keep the arrows attached when a step is dragged (default true) |
| \`dryRun\` | check the process, return warnings + size, draw nothing |

## The findings are the point

\`warnings\` reports the PROCESS, not the drawing:

- an **unlabelled handoff** between two lanes — what actually crossed?
- a step whose \`lane\` does not exist — who owns it?
- no \`start\` (what sets this off?) or no \`end\` (what is the outcome, including
  the unhappy one?);
- a \`decision\` with fewer than two ways out, or branches with no condition;
- a \`fork\` whose branches never reach a \`join\` — nobody waits for the parallel
  work;
- a dead end that is not \`end\`/\`external\`, and a step nothing leads into;
- a lane with no steps.

Use \`options.dryRun\` to iterate on the process before anything is drawn.

## How it is laid out

dagre decides the ORDER of the steps and nothing else: the cross axis belongs
to the lanes, because a step drawn outside its own lane is wrong however good
the graph layout was. The along-gap between two ranks is left generous on
purpose — it is the **corridor** an arrow crossing lanes travels in, so it
never cuts through somebody else's step. An arrow that can run straight does;
one that can do neither (rework going backwards, a skip across three ranks)
goes around the OUTSIDE of every lane.

Lane names read horizontally in a wide name strip rather than rotated.

## The arrows follow the steps

Same as a userflow: while the plugin is open, dragging or resizing a step
re-routes every arrow touching it, and \`figma.reflowDiagram()\` fixes a diagram
rearranged with the plugin closed.

**Drag an arrow's end and it RECONNECTS.** Move the head onto another part of
a box — another face, another spot along the same face — and the line is
re-routed to leave and arrive there properly. The connection point is written
into the diagram's own graph, so it survives the plugin closing AND the arrow goes
on following its boxes from the point you chose. That is the whole difference
from a frozen line.

An edit that says nothing about attachment — a middle bend nudged, the line
parked somewhere — cannot be read as an instruction, so it is left exactly as
you left it and reported as \`pinned\`. \`figma.reflowDiagram({ force: true })\`
puts everything back under automatic routing, forgetting the points that came
from dragging (a \`fromSide\`/\`toSide\` in the spec survives, because that is
the spec's instruction, not a drag).

The arrow head is a stroke CAP on the line, not a separate triangle, so an edge
is one layer: dragging its end takes the head with it. Drag a step into ANOTHER lane's band and the
move is reported, NOT applied — whether the process really changed hands is
your call, so re-run \`figma_diagram\` with the new lane if it did.

## Result

\`{ frameId, name, nodes: { stepId: figmaNodeId }, lanes: { laneId: figmaNodeId },
box, warnings, stats }\` — \`stats.handoffs\` counts the arrows that cross a lane,
which is the number worth quoting back to the reader.

## Placement

Nothing is auto-placed: pass \`x\`/\`y\` (and \`parentId\` to nest inside a frame or
section). \`stats.w\`/\`stats.h\` come back with the result, so lay the next block
out from the previous one's size.
`;
