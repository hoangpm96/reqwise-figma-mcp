export const RULES = `# Safe defaults & rules

The server/plugin layer prevents the classic AI drawing mistakes for you. Rely
on these instead of manual discipline.

## Scope a flow before drawing it
- When the request is a *flow* rather than one screen — "login/signup flow",
  "onboarding", "checkout", "the whole X journey" — the screen list is
  underspecified almost every time. Ask the user a few targeted questions
  BEFORE drawing, so the flow comes out complete instead of a thin happy path.
- Confirm at least: (1) the exact set of screens/steps and their order;
  (2) the states each screen needs (empty / loading / error / success /
  disabled); (3) auth or entry variations (social login, SSO, OTP / email
  verification, "remember me"); (4) platform & frame size (mobile 390×844 vs
  desktop) and light/dark; (5) which real data or copy to show vs placeholder.
- **Offer the userflow first.** Before drawing screens, ask the user plainly:
  *"map the userflow first, then draw the UI?"* \`figma_diagram\` type:"userflow" draws the
  flow from the graph YOU derive from the spec — screens, happy path, error and
  edge cases — and reports the holes in it (a question with one way out, a dead
  end, a screen nobody can reach). Agreeing the flow costs one call; discovering
  a missing branch after eight artboards costs all eight.
- **If a flow already exists on the page**, adding screens means it is now out
  of date. Ask whether to update it in the same pass. The plugin tells you which
  case you are in: drawing a page-level screen returns a warning naming the
  existing userflow, or saying there is none.
- One round of questions now is far cheaper than redrawing every screen after
  the user says "you missed the verify-email and error states". If the user
  says "just draw something", proceed — but state the screens/states you are
  assuming so they can correct you in one message.

## Verify first, always
- After any non-trivial draw, call \`figma_read({op:"layout_audit", nodeId})\`.
  It returns per-node \`declared\` vs \`rendered\` bounds, \`overflowsParent\`,
  \`clippedBy\`, \`textTruncated\`, \`zIndexWarnings\` and non-blocking
  \`styleWarnings\` (radius/padding/contrast consistency). Fix issues with data,
  not by eyeballing screenshots. Screenshots are for final human review only.

## Sizing & clipping
- A child auto-layout frame under a fixed-size parent defaults to
  \`counterAxisSizingMode: FIXED\` on the constrained axis unless you set it.
- Creating a node whose \`x+w > parent.w\` (or y/h) under a clipping parent
  still succeeds, but the response carries \`warnings: ["will be clipped …"]\`.
  Read warnings; do not ignore them.

## Surfaces, radius & padding
- FRAME/COMPONENT without \`fill\`/\`fills\` is transparent by default. Use
  transparent frames for layout wrappers; declare a fill only for a visible
  card, input, button, panel or screen surface.
- Reuse radius tokens. Similar sibling cards/controls should not mix 0/8/12/16px
  arbitrarily. \`layout_audit\` reports radius mismatches in \`styleWarnings\`.
- Visible content containers need at least 12px edge padding; cards/sections
  normally use 16–24px. Flat \`paddingLeft\`/... fields and \`padding\` are both
  supported. \`layout_audit\` reports content that hugs a container edge.

## Overlays
- Never darken a screen by putting a semi-transparent FRAME on top — opacity on
  a FRAME dims the whole subtree. Use \`figma.overlay({color, opacity, parentId})\`.
  It creates a RECTANGLE sized to the parent at the correct layer.

## Text
- For wrapping text use \`create({type:"TEXT", wrap:true, ...})\`. The plugin sets
  \`layoutAlign:STRETCH\`, \`textAutoResize:HEIGHT\` and a sane \`lineHeight\`, and
  warns if the parent has no fixed width (nothing to wrap against).

## Z-order
- Control stacking with \`insertAt: "top" | "bottom" | {above:nodeId} |
  {below:nodeId} | <index>\` on create/move — never rely on creation order.

## Design system: two files, one direction
Keep the human's intent and the machine's snapshot in SEPARATE files — like
\`package.json\` vs \`package-lock.json\`.
- \`design.md\` — HUMAN-authored intent (palette, type ramp, brand voice, which
  components to have). Read it ONLY when BUILDING the design system; the tools
  never overwrite it. If it exists and the file has no DS yet, ask before
  building from it (building is expensive and edits the Figma file).
- \`design-kit.md\` — MACHINE-generated snapshot of what actually exists in
  Figma. Produce it with \`generate_design_md\` and save the returned markdown;
  its header carries a \`<!-- dsfp:… -->\` fingerprint. Regenerate freely — it has
  no hand-written content. Read it (not Figma) when DRAWING, so a screen build
  costs a file read, not a multi-thousand-token scan.
- Flow is always one direction at a time, ending in regenerate:
  build DS (from design.md or an interview) → \`generateDesignMd\` →
  save design-kit.md. Figma is the source of truth; design-kit.md is its
  projection. Never two-way-sync the kit file by hand.
- At the start of a DRAW session, call \`design_fingerprint\` and compare its
  \`hash\` to the \`dsfp:\` in design-kit.md. Match → trust the file. Mismatch →
  someone changed the DS in Figma without regenerating; regenerate first. Names
  are resolved live at draw time (instantiate by name, applyVariable by token
  name), so a slightly stale file fails loudly (name miss + candidates) rather
  than binding the wrong thing.
- Consume by NAME, never by id: token names and component names are the stable
  API; ids change between sessions, so design-kit.md deliberately drives via
  names + fingerprint, not ids.

## Fonts
- Every text op preflights font availability. An unavailable family resolves
  through requested → Inter → system and the response reports
  \`{requestedFont, resolvedFont, reason}\`. Never a silent swap, never a crash.

## Batch
- Many similar ops → \`figma.batch(ops)\`. It streams in chunks (partial commit,
  exact per-index errors). See \`figma_docs(section:"recipes")\`.
`;
