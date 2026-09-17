export const SEQUENCE = `# Sequence diagrams — \`figma_diagram\` type:"sequence"

Draws an exchange over time: participants as columns, messages as arrows in
the order you list them, activation bars showing who is busy, and alt/opt/loop
blocks around the parts that only happen sometimes.

## When this, and when the others

| What the drawing answers | Tool |
|---|---|
| What does the USER see next? | \`figma_diagram\` type:"userflow" |
| WHO does this step, and what is handed over? | \`figma_diagram\` type:"activity" |
| What do we STORE? | \`figma_diagram\` type:"erd" |
| WHAT is sent between systems, in what order, and what comes back? | \`figma_diagram\` type:"sequence" |

Use it for an integration, an API contract, an auth handshake, a webhook — the
places where "the frontend calls the service" hides everything that matters.

## The division of labour

**You think, the tool draws and proof-reads.** The participants, the order of
the messages and what each one carries come from YOUR reading of the spec.
The order of the \`messages\` array IS the time order of the diagram.

## Shape

\`\`\`js
{
  type: "sequence",
  title: "Ký hợp đồng bằng OTP",
  participants: [
    { id: "kh",  name: "Khách hàng", kind: "actor" },
    { id: "app", name: "App", detail: "mobile" },
    { id: "los", name: "LOS", detail: "loan-svc" },
    { id: "sms", name: "SMS gateway", kind: "external" },
  ],
  messages: [
    { id: "m1", from: "kh",  to: "app", label: "Bấm Ký hợp đồng" },
    { id: "m2", from: "app", to: "los", label: "POST /contracts/{id}/sign-otp" },
    { id: "m3", from: "los", to: "sms", label: "sendOtp(phone, code)", kind: "async" },
    { id: "m4", from: "los", to: "app", label: "202 otpSent", kind: "return" },
    { id: "m5", from: "kh",  to: "app", label: "Nhập 6 số" },
    { id: "m6", from: "app", to: "los", label: "POST /verify-otp" },
    { id: "m7", from: "los", to: "app", label: "200 signed", kind: "return" },
    { id: "m8", from: "los", to: "app", label: "409 wrong_otp (còn 4 lần)", kind: "return", cls: "error" },
  ],
  fragments: [
    { kind: "alt", label: "OTP đúng", messages: ["m7"], else: { label: "OTP sai", messages: ["m8"] } },
  ],
}
\`\`\`

### participants[]
\`{ id, name, detail?, kind?, cls? }\`, left to right — order them the way the
exchange flows so most arrows point one way. \`kind\`: \`actor\` a person (drawn
dark) · \`system\` · \`external\` outside the boundary (dashed) · \`queue\` · \`db\`.

### messages[]
\`{ id, from, to, label, kind?, note?, cls? }\` **in time order**.

| \`kind\` | drawn as | means |
|---|---|---|
| \`sync\` (default) | solid, filled head | a call that waits — it also starts an activation bar on the callee |
| \`async\` | solid, open head | fire-and-forget |
| \`return\` | dashed, open head | the reply, which closes the bar |

Say what the message CARRIES: \`POST /verify-otp\`, \`200 signed\`,
\`409 wrong_otp\`. \`from === to\` draws a self-message. \`note\` hangs a small
yellow note under the arrow for the thing that is not in the label (a timeout,
a retry rule). Activation bars are derived from the calls and their replies —
there is nothing to book-keep.

### fragments[]
\`{ kind, label, messages[], else? }\` — a box around a **contiguous** run of
messages. \`alt\` (with \`else\`) · \`opt\` · \`loop\` · \`par\` · \`break\`. The
messages must be contiguous in time: a block that skips a message in the middle
is not a thing a sequence diagram can draw, and that is reported rather than
faked.

## The findings are the point

\`warnings\` reports the EXCHANGE, not the drawing:

- a **reply with no call** to answer — either the call is missing from the
  diagram, or it is not a reply;
- a **call with no reply**, reported only when the diagram answers other calls:
  the reader will otherwise read the silence as "nothing comes back". A message
  from an \`actor\` is exempt — a person tapping a button is not waiting for a
  message;
- an \`alt\` with **no else** — an alternative with one branch is an \`opt\`;
- a fragment that **skips a message** in its range;
- a message with **no label**, a participant **nobody talks to**, duplicate ids.

Use \`options.dryRun\` to iterate before anything is drawn.

## The arrows follow the participants

Dragging a participant moves its whole COLUMN: its lifeline, its activation
bars, every arrow that touches it, and the fragment boxes that span it. What
does not move is TIME — the row a message sits on is its order, and dragging a
head sideways cannot change what happened first. \`figma.reflowDiagram()\` puts a
diagram right that was rearranged with the plugin closed.

## Result

\`{ frameId, name, participants: { id: figmaNodeId }, box, warnings, stats }\`.
\`stats.returns\` counts the replies drawn — the number to check against the
number of calls.
`;
