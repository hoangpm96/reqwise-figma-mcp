export const LAYOUT = `# Relative layout — let the plugin do the math

Avoid manual x/y arithmetic. Positioning helpers compute coordinates from the
parent so a resize of the parent doesn't strand children.

## inset
Pin a node to its parent's edges:

\`\`\`js
await figma.create({
  type: "FRAME", parentId: card.id,
  inset: { left: 16, right: 16, top: 12, bottom: 12 }
});
\`\`\`
The plugin derives x/y/w/h from the parent minus the insets. Omit a side to
leave that dimension to the node's own size.

## align
Center without computing offsets:

\`\`\`js
await figma.create({ type: "TEXT", parentId: hero.id, align: "center", characters: "Welcome" });
\`\`\`
\`align\`: \`"center-x" | "center-y" | "center"\`.

## Auto-layout sizing
- \`layoutMode: "VERTICAL" | "HORIZONTAL"\` turns a frame into an auto-layout.
- Under a fixed-size parent, the constrained axis defaults to
  \`counterAxisSizingMode: FIXED\` (no overflow) unless you override it.
- Use \`primaryAxisSizingMode\`/\`counterAxisSizingMode\` = \`"AUTO"\` (hug) or
  \`"FIXED"\` deliberately; \`layoutAlign:"STRETCH"\` makes a child fill the cross
  axis.

## padding
\`padding: 16\`, \`padding: {left: 16, ...}\`, or the Figma-native flat fields
\`paddingLeft\`/\`paddingRight\`/\`paddingTop\`/\`paddingBottom\`.

## Z-order (insertAt)
On create/move: \`insertAt: "top" | "bottom" | {above: nodeId} | {below: nodeId}
| index\`. Overlays and dropdowns almost always want \`"top"\`.

For transparent-wrapper vs visible-surface rules, spacing minimums, and the
verify-first \`layout_audit\` loop, see figma_docs(section="rules").
`;
