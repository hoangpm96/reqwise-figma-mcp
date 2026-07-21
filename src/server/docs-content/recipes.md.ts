export const RECIPES = `# Recipes

## Session state
\`state\` is a plain object that persists across figma_write calls in the same
session. Set up token maps and id registries once, reuse them later:
\`\`\`js
// call 1
await figma.setupTokens({ colors: { primary: "#2563EB" } });
state.rootId = (await figma.create({ type: "FRAME", name: "Screen", width: 390, height: 844, fill: "#FFFFFF" })).id;
// call 2 (same sessionId) — state.rootId is still here
await figma.create({ type: "TEXT", parentId: state.rootId, characters: "Hi", wrap: true });
\`\`\`
Omit \`sessionId\` to use the default session.

## Verify-first workflow
\`\`\`js
const card = await figma.create({ type: "FRAME", name: "Card", width: 320, height: 200, layoutMode: "VERTICAL", padding: 16, cornerRadius: 16, fill: "#FFFFFF" });
await figma.create({ type: "TEXT", parentId: card.id, wrap: true, characters: "A long paragraph that must wrap…" });
const audit = await figma.layoutAudit(card.id);
if (audit.summary.issues.length) console.warn(audit.summary.issues);
\`\`\`
Then take a screenshot only for the human. \`layoutAudit\` separates blocking
technical defects in \`summary.issues\` from non-blocking \`summary.styleHints\`
such as low contrast, tight padding and inconsistent radius. A screenshot is
still the final visual check for composition and brand fit.

## Typography on TEXT (not silent no-ops)
\`lineHeight\`, \`letterSpacing\`, \`textCase\`, \`textDecoration\`, and
\`paragraphSpacing\` are written on create and modify — same validation style as
\`textAlignHorizontal\` (bad values throw; they are never silently ignored).
\`\`\`js
await figma.create({
  type: "TEXT", parentId: card.id, characters: "SECTION",
  fontSize: 12, letterSpacing: "4%", textCase: "UPPER",
  textDecoration: "NONE", lineHeight: 16,
});
// wrap:true still supplies a default lineHeight only when you omit it:
await figma.create({
  type: "TEXT", parentId: card.id, wrap: true, characters: "Body…",
  lineHeight: 22, // wins over the ~1.45× default
});
\`\`\`

## Overlay (modal scrim)
\`\`\`js
await figma.overlay({ parentId: screen.id, color: "#000000", opacity: 0.5, insertAt: "top" });
\`\`\`
Never a semi-transparent FRAME — that dims the whole subtree.

## Batch streaming (many similar ops)
\`\`\`js
const ops = rows.map((r, i) => ({ op: "create", params: { type: "TEXT", parentId: list.id, characters: r.label } }));
const res = await figma.batch(ops); // { total, ok, failed, results:[{index, ok, result?, error?}] }
res.results.filter(r => !r.ok).forEach(r => console.error(r.index, r.error.message));
\`\`\`
Chunks of 20 stream sequentially. A failing item fails ONLY its index (partial
commit, no rollback); its error is reported at the exact index.

## Insert order (z-index)
\`\`\`js
await figma.create({ type: "RECTANGLE", parentId: screen.id, insertAt: { above: header.id } });
\`\`\`

## Reuse a component
\`\`\`js
const btn = await figma.findOrCreateComponent("Button/Primary", { type: "COMPONENT", /* spec */ });
await figma.instantiate(btn.id, {
  parentId: screen.id,
  props: { "Label#1:2": "Save" }, // exact keys come from generateDesignMd/getComponent
  overrides: { "Label": { text: "Save" } }, // fallback only
});
\`\`\`

## Generate design.md before building UI
\`\`\`js
const spec = await figma.generateDesignMd({ depth: 3, includeAnatomy: true, includeScreens: true });
return spec.markdown; // save as design.md in the target codebase
\`\`\`
What it captures and when to tune the limits: see \`generateDesignMd\` under
figma_docs(section="api").

## Clone and edit a descendant
\`\`\`js
const { id, childMap } = await figma.clone(templateCard.id, { parentId: list.id });
await figma.setText(childMap[templateTitleId], "New title");
\`\`\`

## Edit-in-place lifecycle
Editing what already exists (vs. drawing new nodes) follows one loop:
**readSelection → modify → layoutAudit**. Read what the user picked, mutate it,
then verify structurally.
\`\`\`js
// 1. read what the user selected (ids, types, bounds, text, fills)
const sel = await figma.readSelection({ detail: "compact", depth: 2 });
if (!sel.nodes.length) return "Select something in Figma first.";
const target = sel.nodes[0];
// 2. modify it (any edit-in-place op below, or figma.modify)
await figma.setEffects(target.id, [
  { type: "DROP_SHADOW", color: "#00000033", offset: { x: 0, y: 4 }, radius: 12, spread: 0 },
]);
// 3. verify structurally (not by eyeballing a screenshot)
const audit = await figma.layoutAudit(target.id);
if (audit.summary.issues.length) console.warn(audit.summary.issues);
\`\`\`

## Format-painter overrides (copy one instance onto many)
\`\`\`js
// Style one instance perfectly, then stamp its overrides onto siblings.
const src = await figma.getInstanceOverrides("12:100"); // inspect first (optional)
await figma.setInstanceOverrides("12:100", ["12:101", "12:102", "12:103"]);
\`\`\`
Source and targets must be instances of the same component.

## Recursive recolor
\`\`\`js
// Rebrand a subtree: swap one blue for another across every fill, incl. strokes.
await figma.setSelectionColors("7:20", { from: "#2563EB", to: "#7C3AED", includeStrokes: true });
// Omit \`from\` to replace ALL solid fills; omit nodeId to use the current selection.
await figma.setSelectionColors(undefined, { to: "#111827" });
\`\`\`

## Gradient paint
\`\`\`js
await figma.setGradient(card.id, {
  type: "LINEAR",
  stops: [
    { position: 0, color: "#2563EB" },
    { position: 1, color: "#7C3AED" },
  ],
  // transform omitted → default left→right matrix [[1,0,0],[0,1,0]]
});
\`\`\`
\`type\` ∈ LINEAR | RADIAL | ANGULAR | DIAMOND; needs ≥2 stops. Pass a 2×3
\`transform\` matrix to rotate/scale the gradient; \`target: "stroke"\` paints the
stroke instead of the fill.

## Making it look good (không chỉ đúng cấu trúc)
A "correct" tree can still look unfinished. The palette-first rule and the
transparent-wrapper vs visible-surface distinction live in
figma_docs(section="rules"); the recipes below are the intentional defaults for
the common surfaces. (\`setupTokens\` the agreed palette once, then
\`applyVariable\` instead of re-typing hexes.)

### 1. Full-width button
\`layoutAlign: "STRETCH"\` is what makes the button full-width — not computing
a pixel width by hand.
\`\`\`js
const button = await figma.create({
  type: "FRAME", name: "Button/Primary", parentId: card.id,
  layoutMode: "HORIZONTAL", layoutAlign: "STRETCH",
  height: 50, cornerRadius: 12,
  fills: [{ type: "SOLID", color: "#2563EB" }],
  primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER",
  primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED",
});
await figma.create({
  type: "TEXT", parentId: button.id, characters: "Continue",
  fontSize: 16, fontName: { family: "Inter", style: "Semi Bold" },
  fills: [{ type: "SOLID", color: "#FFFFFF" }],
});
\`\`\`

### 2. Card
Background fill + radius + even padding + gap between children, not manual
child offsets.
\`\`\`js
const card = await figma.create({
  type: "FRAME", name: "Card", parentId: screen.id,
  layoutMode: "VERTICAL", layoutAlign: "STRETCH",
  primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED",
  paddingLeft: 20, paddingRight: 20, paddingTop: 20, paddingBottom: 20,
  itemSpacing: 12,
  fills: [{ type: "SOLID", color: "#FFFFFF" }],
  strokes: [{ type: "SOLID", color: "#E5E7EB" }], strokeWeight: 1,
  cornerRadius: 16,
});
// children of card use layoutAlign:"STRETCH" to fill its width
\`\`\`

### 3. Input field
Label above a bordered box, not a bare text node floating over a rectangle.
\`\`\`js
const field = await figma.create({
  type: "FRAME", name: "Field/Email", parentId: card.id,
  layoutMode: "VERTICAL", layoutAlign: "STRETCH", itemSpacing: 6,
  primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED",
});
await figma.create({
  type: "TEXT", parentId: field.id, characters: "Email",
  fontSize: 13, fills: [{ type: "SOLID", color: "#6B7280" }],
});
const box = await figma.create({
  type: "FRAME", parentId: field.id, layoutAlign: "STRETCH",
  layoutMode: "HORIZONTAL", counterAxisAlignItems: "CENTER",
  height: 48, paddingLeft: 14, paddingRight: 14,
  fills: [{ type: "SOLID", color: "#F9FAFB" }],
  strokes: [{ type: "SOLID", color: "#E5E7EB" }], strokeWeight: 1,
  cornerRadius: 10,
});
await figma.create({
  type: "TEXT", parentId: box.id, characters: "you@example.com",
  fontSize: 15, fills: [{ type: "SOLID", color: "#9CA3AF" }],
});
\`\`\`

### 4. Vertical stack with gaps
Use \`itemSpacing\` on the auto-layout parent. Anti-pattern: an empty 1px
"Spacer" FRAME between siblings — it's fragile and invisible in the tree's
intent. Set the gap once on the parent instead.
\`\`\`js
await figma.create({
  type: "FRAME", name: "Form", parentId: screen.id,
  layoutMode: "VERTICAL", layoutAlign: "STRETCH", itemSpacing: 16,
}); // fieldA, fieldB, button all get 16px apart automatically -- no spacers
\`\`\`

### 5. Text hierarchy
Always set a color and size explicitly — never leave text at its default
black/12px. Heading and body should read as different weights of importance.
\`\`\`js
await figma.create({
  type: "TEXT", parentId: screen.id, characters: "Welcome back",
  fontSize: 26, fontName: { family: "Inter", style: "Bold" },
  fills: [{ type: "SOLID", color: "#111827" }],
  // To CENTER a title/link/label, set textAlignHorizontal (aligns the glyphs in
  // the text box) AND give the box a width via layoutAlign:"STRETCH". Do NOT use
  // \`align\` for this — \`align\` moves the whole node, not its text content.
  layoutAlign: "STRETCH", textAlignHorizontal: "CENTER",
});
await figma.create({
  type: "TEXT", parentId: screen.id, characters: "Sign in to continue", wrap: true,
  fontSize: 15, fills: [{ type: "SOLID", color: "#6B7280" }],
});
\`\`\`

### Checklist trước khi báo xong
- Mọi frame nội dung (card, button, field, header…) có \`fills\` nền/màu, không
  còn frame trần trong suốt?
- Nút và input field đã \`layoutAlign:"STRETCH"\` để full-width, không phải
  width cố định đoán mò?
- Khoảng cách giữa các phần tử dùng \`itemSpacing\` (gap), không phải spacer
  frame 1px?
- Mọi \`TEXT\` đã set \`fills\` (màu chữ) và \`fontSize\` phù hợp vai trò
  (heading/body/label), không để mặc định?
- Đã hỏi user về palette/design tokens, hoặc tái dùng \`design.md\`/token có
  sẵn, trước khi vẽ màu?
- \`layoutAudit\` sạch (không overflow/clip/truncate) -- nhưng nhớ đó chỉ là
  kiểm tra kỹ thuật, không phải kiểm tra thẩm mỹ.
- Chỉ chụp một screenshot cuối cùng cho human sau khi mọi thứ ở trên đã ổn
  -- mỗi screenshot tốn khoảng 6-15K token, đừng chụp lặp lại để "xem thử".
`;
