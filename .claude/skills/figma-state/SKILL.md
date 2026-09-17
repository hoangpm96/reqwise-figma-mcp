---
name: figma-state
description: Draw a UML state machine on Figma for ONE entity — every value it can hold and every change that is allowed, with the event, guard and action on each. Reach for it whenever a spec has a status field.
allowed-tools: Read, Glob, Grep, AskUserQuestion, mcp__reqwise-figma__figma_status, mcp__reqwise-figma__figma_docs, mcp__reqwise-figma__figma_read, mcp__reqwise-figma__figma_diagram, mcp__reqwise-figma__figma_write
user-invocable: true
argument-hint: "<entity> [source file or @tag]"
---

# /figma-state — What a record is allowed to be

Read `../reqwise-diagram-rules.md` first — connection gate, the four levels of correct, the
findings loop, frame placement, verification. This file carries only what is specific to a
state machine.

## Goal

Turn a status field into a contract. A spec says `status: draft | pending | approved |
rejected` and stops; the questions it never answers are which change is allowed from which,
what triggers it, and what has to be true first. That is what a developer needs to write the
guard clause and a tester needs to know what to try.

Output: one Figma frame `State · <title>` for **one entity**, plus the transition questions the
diagram exposed.

## Constraints

### Hard rules — never violate

- **One entity per diagram.** Two lifecycles on one canvas is two diagrams sharing a frame,
  and every reader loses track of which state belongs to which. Draw the second one separately.
- **Exactly one `kind: "initial"`**, and at least one `kind: "final"` unless the entity
  genuinely never ends (a session, a switch). The tool reports both.
- **Every transition needs a reason** — see the table below. This is the rule the tool checks
  hardest, and the one specs leave out most often.
- **Use the states the SYSTEM uses.** If the DB stores `pending_review`, the `id` is
  `pending_review` and the `label` is what a human calls it ("Chờ duyệt"). A diagram whose
  state names do not match the data is a diagram nobody can implement against.
- **Never invent a transition to connect an orphan.** A state nothing can reach is a finding
  about the spec, not a missing arrow.

### Write it in the compact form

`text` is one line per thing, and the transition line **is** the UML sentence — which is what
keeps `event`, `guard` and `action` three separate things instead of one string with the guard
missing.

```
held   "Seats held"
  entry hold_expires_at = now() + 10 min
  detail booking_seats rows written
paying "Awaiting payment"
  do wait for the payment gateway
paid   "Paid" final ok                  # kind + class on the state line
void   "Released" final err
[*] -> held:   Reserve the seats / insert bookings
held -> paying: Confirm the order [payment method chosen] / insert payments
held -> held:   Change seats            # a self-transition is normal, not odd
paying ~> held: Gateway declined [attempts < 3] !err    # ~> is a way BACK
paying -> paid: Gateway confirmed
paying -> void: [attempts = 3]          # guard only, no event
```

`[*]` is the starting dot. `->` is a forward transition, `~>` a way back (retry, reopen,
revert). Everything after the `:` is read as `event [guard] / action`, so the three fields stay
three fields.

### The transition table — read this before writing a single transition

The habit is to label an arrow with one string. UML wants three things, and the compact line
keeps them apart by position.

| Want to say | Write | NOT |
|---|---|---|
| Sending it for approval moves it on | `draft -> review: Gửi duyệt` | putting the condition in the same phrase |
| …but only if the file is complete | `draft -> review: Gửi duyệt [đủ hồ sơ]` | `Gửi duyệt khi đủ hồ sơ` — now it is prose, not a guard |
| …and it notifies the approver on the way | `draft -> review: Gửi duyệt [đủ hồ sơ] / notify(QLTD)` | describing the action in the target state's label |
| It moves on by itself when the work finishes | source has a `do` line, transition has no event: `review -> signed:` | an empty event out of a state with no `do` |
| Two outcomes on the same event | give **each** a `[guard]` | two lines with the same event and no guards |
| It handles this without leaving the state | `draft -> draft: Lưu nháp` | omitting it because self-loops look odd |
| It can come back (reopen, retry, revert) | `review ~> draft: Yêu cầu bổ sung` | `->`, which draws it as ordinary forward flow |

The one that bites in production is row 5. Two transitions leaving one state on the same event
with nothing to choose between them means **whichever branch the implementation evaluates
first wins**, and the diagram promised nothing. The tool reports it; treat it as a bug.

### Pitfalls — easy to get wrong

- **`entry` / `do` / `exit` are behaviours, not descriptions.** `entry: "gửi email xác nhận"`
  is right; `entry: "trạng thái chờ duyệt"` is just the state's name again.
- **A `do` changes what an unlabelled exit means.** Only give a state a `do` if something
  genuinely runs while it sits there — do not add one to silence a warning about a missing
  event.
- **`choice` vs two guarded transitions.** Use `kind: "choice"` when the branch is decided by
  evaluating a condition *after* arriving; use two guarded transitions when the event itself
  differs. When in doubt, two guarded transitions read better.
- **A final state has no way out.** If the record can come back from "Đã huỷ", it is an
  ordinary state and the lifecycle is longer than the spec claimed. That is a finding.
- **Do not model the UI.** "Đang xem chi tiết" is a screen, not a state of the contract. If it
  would not be stored, it does not belong here — draw it with `/figma-userflow`.
- **Timeouts are events too.** "hết 5 phút", "quá hạn 1 kỳ". A lifecycle with no time-driven
  transition is usually one that has not been thought through.

## Inputs

```
/figma-state "Hợp đồng vay"                     # interview from scratch
/figma-state "Đơn hàng" @docs/srs/spec.md       # derive from a source, ask only the gaps
/figma-state                                     # asks which entity
```

Any source works. If the workspace holds a state-transition table (a brainstorm section, an
SRS business-rules list, a DB enum), read it — but never require it.

## Approach

### Phase 0 — Connection

Per shared rules §5.

### Phase 1 — Derive the model, and name the gaps

Build the **fact-list** you will check the drawing against:

1. **The entity**, and where its status actually lives (a column, an enum, a flag).
2. **Every value** it can hold — including the ones only ops or support ever see.
3. **For each allowed change**: from, to, the event, the guard, the action.
4. **Changes that are explicitly forbidden** ("không quay lại từ `paid` về `pending`").
5. **What ends the lifecycle**, in all its variants — settled, cancelled, expired.

Anything the source does not say, **ask**, in business language: *what makes it move from
here?* · *can it ever go back?* · *what happens if nobody acts for a month?* · *which of these
is the end?*

Forbidden transitions are worth asking about explicitly. They will not appear on the diagram —
a state machine draws what IS allowed — but knowing them is how you notice a missing guard.

### Phase 2 — Ask the one question that changes the drawing

**Which way should it read: `rankdir: "LR"` (left→right, the default) or `"TB"` (downwards)?**
A mostly-linear lifecycle reads well left→right; one with many branches back to an earlier
state is usually clearer top→bottom. It costs nothing to ask and it changes the whole shape.

### Phase 3 — Check, then draw, in one call

Call `figma_diagram` with `type: "state"` and `options: { checkFirst: true }`: it checks the model and
**draws only if there are no findings**. Dirty → `checkedOnly: true` + the findings and nothing
is drawn; clean → it draws and returns `audit` in the same call. (`options: { dryRun: true }`
is still there for iterating on a model you expect to be wrong.)

Read every warning. The ones specific to this kind:

| Warning | What it usually means |
|---|---|
| Unreachable from the initial state | a transition into it is missing, or it is a value the record can never hold |
| No way out of "X" | the record gets stuck there and nobody said so — mark it `final`, or say what moves it on |
| N transitions on the same event with no guard | the classic bug — add a `[guard]` to each |
| Final state with a way out | it is not final; the lifecycle is longer than the spec said |
| Transition with no event and no guard | say what triggers it, or give the source a `do` |
| Choice has N branches with no guard | a reader cannot tell which one is taken |

Fix the model, re-dry-run, then draw.

### Phase 4 — Draw, verify, report

1. Place the frame clear of what is on the page (shared rules §7).
2. Draw.
3. Read `audit` from the same result — it is the render-side check (overflow, clipping,
   truncation). Fix anything it reports. No second call for it.
4. One `screenshot` per SET of diagrams at the end, not one per frame — skip it when
   `audit` is clean and the human is watching Figma live.
5. Report per shared rules §11, and list the forbidden transitions from Phase 1 as prose
   beside the diagram — they are part of the contract even though they are not drawn.

## What the machine does NOT check

- whether these are the **real** states — the checker cannot know that ops has a sixth value
  nobody documented;
- whether a guard is correct, only that one exists;
- whether the entity actually needs a state machine (two states and a boolean is a table, not
  a diagram);
- whether the code enforces any of it. This diagram is the specification the code should be
  tested against, not evidence about the code.
