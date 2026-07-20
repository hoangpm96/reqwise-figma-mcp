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

## align — position the NODE in its parent
Center a whole node without computing offsets:

\`\`\`js
await figma.create({ type: "FRAME", parentId: hero.id, align: "center", w: 200, h: 48 });
\`\`\`
\`align\`: \`"center-x" | "center-y" | "center"\`. This moves the node's box
(equivalent to setting x/y); it does NOT align the content inside a TEXT node.

## textAlignHorizontal / textAlignVertical — align text CONTENT in its box
To center the characters inside a TEXT node's own frame (the usual meaning of
"center this text"), set \`textAlignHorizontal\` — NOT \`align\`:

\`\`\`js
await figma.create({
  type: "TEXT", parentId: card.id, characters: "Welcome",
  layoutAlign: "STRETCH",            // make the text box span the parent width
  textAlignHorizontal: "CENTER",     // center the glyphs within that box
});
\`\`\`
\`textAlignHorizontal\`: \`"LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED"\`.
\`textAlignVertical\`: \`"TOP" | "CENTER" | "BOTTOM"\`. Both work on create and
modify; an invalid value throws INVALID_PARAMS (it is never silently ignored).
Note: for a hug-width text node, LEFT vs CENTER looks identical — give the node
a width (\`layoutAlign:"STRETCH"\` or an explicit \`w\`) so the alignment is
visible.

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
