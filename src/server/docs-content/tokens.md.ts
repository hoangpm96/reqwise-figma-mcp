export const TOKENS = `# Design tokens & variables

Set tokens up ONCE per session, then reference them by name. The session token
map lives in \`state.tokens\` and survives across figma_write calls.

## Setup (idempotent)
\`\`\`js
await figma.setupTokens({
  colors:  { primary: "#2563EB", surface: "#0B0B0F", "on-surface": "#F5F5F7" },
  numbers: { "radius-md": 8, "space-4": 16 },
  strings: { "font-body": "Inter" }
});
\`\`\`
Re-running with the same names updates values without creating duplicates.

## Multi-mode (light/dark)
Variables get values for ALL modes explicitly. Provide per-mode values:
\`\`\`js
await figma.setupTokens({
  colors: { surface: { light: "#FFFFFF", dark: "#0B0B0F" } }
});
\`\`\`
This fixes the figma-ui-mcp bug where only the current mode was set and the
other mode silently kept the default.

## Applying a token
\`\`\`js
await figma.applyVariable(node.id, "fills", "primary");
await figma.applyVariable(frame.id, "cornerRadius", "radius-md");
\`\`\`

## Prefer tokens over raw hex
Once you have set up tokens, bind them with \`applyVariable\` instead of writing
the same hex literal again — it keeps themes coherent and lets a single edit
re-theme everything. The session token map is available at \`state.tokens\`
(name → value) so you can look names up without re-declaring them.

## Reading
\`figma.getVariables()\` (or \`figma_read\`) lists collections, modes and
variables — use it to discover what a design system already defines before
adding new tokens.
`;
