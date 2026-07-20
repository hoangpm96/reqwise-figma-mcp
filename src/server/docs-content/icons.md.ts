export const ICONS = `# Icons

Icons resolve across libraries by semantic name. The server keeps a cross-
library alias map so you can ask for what you *mean* and get the name each
library actually ships.

## Search first (cheap, no fetch)
\`\`\`js
const candidates = await figma.searchIcons("visibility");
// → [{ name: "eye", alias: "visibility", libraries: [...] }, ...]
\`\`\`
\`searchIcons\` never downloads SVGs — it only resolves candidate canonical
names so you can pick before paying for a fetch.

## Common aliases
\`visibility → eye\`, \`delete → trash\`, \`done/checkmark → check\`,
\`close/cancel → x\`, \`add → plus\`, \`edit → pencil\`, \`settings → gear\`,
\`more → more-horizontal\`, \`back → arrow-left\`, \`logout → log-out\`, and ~40
more. Unknown names pass through unchanged.

## Load & draw
\`\`\`js
await figma.loadIcon("visibility", { library: "lucide", size: 24, color: "#F5F5F7", parentId: btn.id });
\`\`\`
The SVG is fetched server-side (unpkg), cached on disk under
\`$TMPDIR/reqwise-figma-mcp/cache/\`, then handed to the plugin which turns the
SVG into Figma vector nodes. Supported libraries: \`lucide\` (default),
\`ionicons\`, \`tabler\`, \`bootstrap-icons\`.

## When an icon is missing
A miss throws \`NODE_NOT_FOUND\` with a hint to \`searchIcons\` again or try a
different \`{ library }\`. The "localhost-only" rule is about the Figma bridge —
icon/image loading is an allowed, cached external fetch.
`;
