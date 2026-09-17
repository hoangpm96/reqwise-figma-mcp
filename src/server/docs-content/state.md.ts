export const STATE = `# State machine — figma_diagram type:"state"

The lifecycle of ONE entity: every value it can hold, and every change that is
allowed. Reach for it whenever a spec has a status field — the set of legal
values and legal transitions is what a developer needs to write the guard
clause and a tester needs to know what to try, and it is the part of a spec
that is almost always left implicit.

Pick the diagram by the question:

| question | tool |
| --- | --- |
| what does the user see next | \`figma_diagram\` type:"userflow" |
| who does each step | \`figma_diagram\` type:"activity" |
| what do we store | \`figma_diagram\` type:"erd" |
| what is sent, and in what order | \`figma_diagram\` type:"sequence" |
| what can this ONE record be, and what moves it | \`figma_diagram\` type:"state" |

## Shape

\`\`\`json
{
  "type": "state",
  "title": "Vòng đời hợp đồng vay",
  "x": 0, "y": 0,
  "states": [
    { "id": "begin", "kind": "initial" },
    { "id": "draft", "label": "Nháp", "entry": "tạo mã HĐ", "detail": "chỉ CVKH thấy" },
    { "id": "review", "label": "Chờ duyệt", "do": "chấm điểm tín dụng" },
    { "id": "signed", "label": "Đã ký", "cls": "happy" },
    { "id": "rejected", "label": "Bị từ chối", "kind": "final", "cls": "error" },
    { "id": "done", "label": "Đã tất toán", "kind": "final", "cls": "happy" }
  ],
  "transitions": [
    { "from": "begin", "to": "draft" },
    { "from": "draft", "to": "review", "event": "Gửi duyệt", "guard": "đủ hồ sơ", "action": "notify(QLTD)" },
    { "from": "review", "to": "signed", "event": "Duyệt", "action": "sinh lịch trả nợ" },
    { "from": "review", "to": "rejected", "event": "Từ chối", "cls": "error" },
    { "from": "review", "to": "draft", "event": "Yêu cầu bổ sung", "kind": "return" },
    { "from": "draft", "to": "draft", "event": "Lưu nháp" },
    { "from": "signed", "to": "done", "event": "Trả hết nợ" }
  ]
}
\`\`\`

## The label is a sentence

A transition is drawn the UML way, \`event [guard] / action\`:

- **event** — what triggers it. An action, a timer, a webhook. This is the one
  people forget, and without it the diagram says a record changes by itself.
- **guard** — what has to be true. Drawn in brackets. Two transitions leaving
  one state on the SAME event need guards to tell them apart, or whichever the
  implementation happens to check first wins.
- **action** — what the system does on the way through. Drawn after a slash.

Leave the event off only when the source state has a \`do\` activity: that is
UML's completion transition, and it reads as "when that finishes".

## Notation

- \`kind:"initial"\` — the starting dot. **Exactly one.** Nothing may point at it.
- \`kind:"final"\` — a ring. Several is fine (settled, cancelled, expired).
- \`kind:"choice"\` — a diamond, when the branch is decided by a condition
  rather than by an event. Every branch but at most one needs a \`[guard]\`.
- \`kind:"fork"\` / \`"join"\` — concurrent regions, and where they rejoin.
- \`kind:"return"\` on a transition — a way BACK (reopen, retry, revert). Drawn
  dashed and routed around the outside, so rework does not cut through the flow.
- **A self-transition** (\`from\` === \`to\`) is normal and draws as a loop: it is
  how you say an event is handled without leaving the state.

## What it tells you

\`warnings\` is about the MACHINE, not the drawing. Read them and go back to the
spec:

- a state **nothing can reach** from the initial state;
- a state with **no way out** that is not marked final — the record gets stuck
  there and nobody said so;
- **two transitions on the same event with no guard** — the classic bug;
- a **final state with a way out**, which makes it an ordinary state;
- a **choice** that does not branch, or whose branches are unlabelled;
- a **fork with no join**;
- a transition with **no event and no guard** out of a state that has no \`do\`.

Pass \`options.dryRun\` to get all of that without drawing anything.

## Layout

\`options.rankdir\` is "LR" (default, reads left→right) or "TB" (downwards).
Arrows stay attached: dragging a state re-routes every transition touching it
while the plugin is open, and \`figma.reflowDiagram()\` fixes a diagram
rearranged with it closed. Dragging a transition's END reconnects it — the
connection point is adopted into the graph and the line re-routed through it,
still following the states. \`fromSide\`/\`toSide\` + \`fromAt\`/\`toAt\` are the
declarative twin, for pulling two crossing arrows apart up front.

## Sub-machines

A composite state is not drawn. When a state has a lifecycle of its own, give
it its own \`type:"state"\` diagram and name the parent state in the \`subtitle\` —
one machine per picture is what keeps either of them readable.
`;
