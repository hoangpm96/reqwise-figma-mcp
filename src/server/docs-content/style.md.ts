export const STYLE = `# Default taste — vẽ cho đẹp khi CHƯA có design.md

Đây là bộ gu MẶC ĐỊNH, chỉ dùng khi file Figma chưa có design system VÀ codebase
không có \`design.md\`. Nếu có \`design.md\` hoặc file đã có tokens/styles/components,
BỎ QUA phần này — intent của user luôn thắng. Bộ dưới đây brand-neutral: đổi đúng
MỘT biến \`color/primary\` là ra brand khác, phần còn lại giữ nguyên vẫn đẹp.

Trích từ Tailwind / Radix / Material 3 / Apple HIG. Đây là điểm KHỞI ĐẦU tử tế,
không phải luật cứng — user sửa thoải mái.

---

## Vì sao bản vẽ trông "đơ" (và cách chữa)

"Đơ" = kỹ thuật đúng nhưng vô hồn. Bảy nguyên nhân, xếp theo mức sát thương:

1. **Phẳng lì — không có độ sâu.** Mọi surface cùng một mặt phẳng, không shadow,
   không phân tầng. → Card/popover/button nổi phải có elevation (mục Elevation).
   Nền trang, card, và control phải ở 3 độ sáng khác nhau, không cùng một màu.
2. **Mọi thứ cùng một "giọng".** Heading, body, label cùng weight/màu → mắt không
   biết nhìn đâu trước. → Phân cấp bằng BA kênh cùng lúc: **size + weight + màu**
   (mục Type + Color). Đừng chỉ đổi mỗi size.
3. **Spacing đều tăm tắp → không có nhóm.** Nếu mọi \`itemSpacing\` bằng nhau, không
   gì "thuộc về nhau". → **Khoảng cách TRONG nhóm < khoảng cách GIỮA các nhóm.**
   Label sát input nó mô tả (8px), nhưng các field cách nhau xa hơn (16–24px).
4. **Chật chội hoặc dàn đều vô hồn.** → Bắt đầu bằng THỪA white space rồi bớt dần.
   Section lớn dùng gap cao (48/64), không phải 16 khắp nơi.
5. **Màu chết.** \`#000\`/\`#FFF\` thuần và xám vô sắc \`#808080\` làm UI trông rẻ và
   mỏi mắt. → off-black/off-white + xám ÁM nhẹ theo hue primary (mục Color).
6. **Line-height một cỡ cho tất cả.** Heading 32px mà line-height 1.5 thì trông
   rời rạc. → line-height GIẢM khi cỡ chữ TĂNG (mục Type).
7. **Canh giữa tất cả.** Mọi thứ căn giữa → không có mỏ neo thị giác. → Nội dung
   đọc (text, form) căn TRÁI; chỉ căn giữa hero/empty-state/dialog ngắn.

Luật vàng: **mọi giá trị lấy từ một THANG hữu hạn bên dưới, không bịa số lẻ.**
Đắn đo 13 hay 15px nghĩa là đang làm sai — thang chỉ cho chọn 12 hoặc 14 hoặc 16.

---

## Type — thang chữ (font: Inter, hoặc Space Grotesk cho heading nếu muốn nét hơn)

Line-height GIẢM DẦN khi size tăng. Đây là thứ hay bị sai nhất.

| Vai trò        | size | line-height | weight | letter-spacing |
|----------------|------|-------------|--------|----------------|
| display        | 48   | 52 (1.08)   | 700    | -0.02em        |
| title          | 32   | 38 (1.2)    | 700    | -0.01em        |
| heading        | 24   | 30 (1.25)   | 600    | -0.005em       |
| subheading     | 20   | 28 (1.4)    | 600    | 0              |
| body-lg        | 18   | 28 (1.55)   | 400    | 0              |
| body           | 16   | 24 (1.5)    | 400    | 0              |
| label          | 14   | 20 (1.43)   | 500    | 0              |
| caption        | 12   | 16 (1.33)   | 400    | +0.0025em      |

\`\`\`js
await figma.setupTextStyles([
  { name: "display",    fontSize: 48, weight: 700, lineHeight: 52, letterSpacing: "-2%",   fontFamily: "Inter" },
  { name: "title",      fontSize: 32, weight: 700, lineHeight: 38, letterSpacing: "-1%",   fontFamily: "Inter" },
  { name: "heading",    fontSize: 24, weight: 600, lineHeight: 30, letterSpacing: "-0.5%", fontFamily: "Inter" },
  { name: "subheading", fontSize: 20, weight: 600, lineHeight: 28, fontFamily: "Inter" },
  { name: "body-lg",    fontSize: 18, weight: 400, lineHeight: 28, fontFamily: "Inter" },
  { name: "body",       fontSize: 16, weight: 400, lineHeight: 24, fontFamily: "Inter" },
  { name: "label",      fontSize: 14, weight: 500, lineHeight: 20, fontFamily: "Inter" },
  { name: "caption",    fontSize: 12, weight: 400, lineHeight: 16, letterSpacing: "0.25%", fontFamily: "Inter" },
]);
\`\`\`
Rồi vẽ bằng \`textStyle: "heading"\` — KHÔNG bao giờ hardcode \`fontSize\` rời rạc.
Quy tắc: một màn hình dùng 3–4 style là đủ; đừng dùng cả 8.

## Spacing — lưới 4px (mọi gap/padding lấy từ đây)

\`2, 4, 8, 12, 16, 24, 32, 40, 48, 64, 80, 96\` — trên 24 thì nhảy bậc để các mức
còn phân biệt được. Nhớ: **trong nhóm < giữa nhóm.**

\`\`\`js
await figma.setupTokens({ numbers: {
  "space/2": 2, "space/1": 4, "space/2x": 8, "space/3": 12, "space/4": 16,
  "space/6": 24, "space/8": 32, "space/10": 40, "space/12": 48, "space/16": 64,
}});
\`\`\`
Gợi ý: padding card 24, gap giữa các field 16, gap label↔input 8, gap giữa các
section 48–64. Nút/input cao 44–48 (44 là tap-target tối thiểu của Apple).

## Radius — bo góc

\`4, 8, 12, 16, 9999(pill)\`. Input/button nhỏ dùng 8–10; card dùng 12–16; pill
dùng 9999. **Corner smoothing 60%** (\`cornerSmoothing: 0.6\`) cho cảm giác iOS mượt.

Luật LỒNG NHAU (rất hay bị sai, làm góc trông "phình"):
\`\`\`
radius_ngoài = radius_trong + padding
\`\`\`
Icon bo 8 nằm trong padding 8 → nút bọc ngoài bo 16, không phải cũng 8.

\`\`\`js
await figma.setupTokens({ numbers: {
  "radius/sm": 8, "radius/md": 12, "radius/lg": 16, "radius/pill": 9999,
}});
\`\`\`

## Color — off-black/off-white + xám ÁM theo primary

KHÔNG \`#000\`/\`#FFF\` thuần. KHÔNG xám vô sắc. Palette dưới trung tính-mát; đổi
\`color/primary\` sang brand của bạn là xong.

\`\`\`js
await figma.setupTokens({ colors: {
  "color/canvas":     "#FCFCFD",  // nền trang (off-white)
  "color/surface":    "#FFFFFF",  // card/panel — sáng hơn canvas 1 bậc
  "color/surface-2":  "#F4F4F6",  // nền lồng / hovered
  "color/ink":        "#1C2024",  // text chính (off-black, KHÔNG #000)
  "color/ink-muted":  "#60646C",  // text phụ (xám ám lạnh, đọc được: ~5.8:1)
  "color/ink-subtle": "#8B8D98",  // text mờ nhất — chỉ caption/placeholder
  "color/border":     "#E2E8F0",  // hairline; hoặc dùng đen 8% cho đa nền
  "color/primary":    "#2563EB",  // << ĐỔI SANG BRAND. Phần còn lại giữ nguyên.
  "color/on-primary": "#FFFFFF",
  "color/success":    "#16A34A",
  "color/danger":     "#DC2626",
}});
\`\`\`
Ba bậc text (ink / ink-muted / ink-subtle) là thứ tạo phân cấp mà không cần đổi
size. Xám phải ám cùng phía hue với primary (primary lạnh → xám hơi xanh; primary
ấm → xám hơi nâu) — xám vô sắc cạnh màu bão hòa sẽ trông "chết".

Contrast: text thường cần ≥ 4.5:1, text lớn/UI ≥ 3:1. KHÔNG bao giờ chữ xám trên
nền màu — dùng một biến thể cùng hue, sáng/tối hơn.

## Elevation — thứ chữa "phẳng lì" nhanh nhất

Đừng dùng shadow một-lớp đen-đậm mặc định. Dùng ĐA LỚP, alpha thấp, ám nhẹ,
CÙNG một nguồn sáng (offset y dương, x=0). Định nghĩa MỘT LẦN thành effect
style (token hóa elevation), rồi tái dùng theo tên — đừng lặp lại inline.

\`\`\`js
// định nghĩa ramp elevation một lần (idempotent, upsert theo tên)
await figma.setupEffectStyles([
  { name: "elevation/card", effects: [
    { type: "DROP_SHADOW", color: "#1C202412", offset: { x: 0, y: 1 }, radius: 2,  spread: 0 },
    { type: "DROP_SHADOW", color: "#1C20240F", offset: { x: 0, y: 4 }, radius: 12, spread: -2 },
  ]},
  { name: "elevation/overlay", effects: [
    { type: "DROP_SHADOW", color: "#1C20241A", offset: { x: 0, y: 8 }, radius: 24, spread: -6 },
    { type: "DROP_SHADOW", color: "#1C20240D", offset: { x: 0, y: 2 }, radius: 6,  spread: -2 },
  ]},
]);
// rồi áp: card dùng elevation/card, popover/modal dùng elevation/overlay.
// (setEffects với các effect y hệt cũng được, nhưng token hóa thì nhất quán hơn.)
\`\`\`
Ba mức là đủ: phẳng (0, chỉ hairline border) → card → overlay. Elevation càng
cao thì blur càng rộng, opacity mỗi lớp càng THẤP. Màu shadow ám theo ink
(\`#1C2024xx\`), KHÔNG phải \`#000000\`. Nếu gọi \`setEffects\` mà bỏ trống màu/
offset/radius, mặc định giờ đã là shadow mềm hiện đại (ink 10%, y4, blur12),
không còn là đen-đậm 25%.

Khi nào shadow vs border: card trên nền phẳng → shadow nhẹ. Phần tử trong list/
table → chỉ border, đừng shadow (nhiều shadow cạnh nhau thành "đục").

## Chốt nhanh — checklist chống-đơ trước khi báo xong

- [ ] 3 độ sáng surface khác nhau (canvas / surface / surface-2)? Không phẳng lì?
- [ ] Phân cấp text dùng cả size + weight + màu, không chỉ một kênh?
- [ ] Spacing TRONG nhóm nhỏ hơn GIỮA nhóm? (label sát input, field cách nhau xa)
- [ ] Mọi số lấy từ thang (4px grid, type scale)? Không có 13/15/17/50?
- [ ] Text đọc căn TRÁI, không phải căn giữa mọi thứ?
- [ ] Card/nút nổi có elevation đa-lớp ám nhẹ, không phải shadow đen một-lớp?
- [ ] Không \`#000\`/\`#FFF\` thuần; xám ám theo hue primary?
- [ ] line-height của heading chặt hơn body (1.1–1.25 vs 1.5)?
`;
