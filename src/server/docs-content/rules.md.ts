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

## Reuse before create
- Call \`figma.findComponent(query)\` (COMPONENT + COMPONENT_SET, fuzzy and
  set/variant path-aware) before
  creating. \`findOrCreateComponent(name, spec)\` makes reuse the default.
- For an existing design system, call
  \`figma_read({op:"generate_design_md", params:{depth:3, includeAnatomy:true, includeScreens:true}})\` first and save the
  returned markdown as \`design.md\`. It reports coverage and screen usage,
  then lists variables, styles, exact Figma ids/keys, component variants and
  property keys, text layers, layout/radius evidence and known gaps. Do not set \`maxOutputChars\` unless you
  deliberately want a shortened brief.
- When instantiating a component, prefer component \`props\` with the exact keys
  from \`design.md\`; use layer-name overrides only when no component property
  exists.

## Fonts
- Every text op preflights font availability. An unavailable family resolves
  through requested → Inter → system and the response reports
  \`{requestedFont, resolvedFont, reason}\`. Never a silent swap, never a crash.

## Batch
- Many similar ops → \`figma.batch(ops)\`. It streams in chunks (partial commit,
  exact per-index errors). See \`figma_docs(section:"recipes")\`.
`;
