# Multi-agent — Cursor, Claude Code, Codex cùng điều khiển Figma

> Một repo MCP · một launcher · một leader bridge · nhiều agent session · (tuỳ chọn) nhiều cửa sổ Figma.
>
> **Reqwise Studio (app):** giao diện quản lý phần này là module **M17 Multi-agent hub**
> trong [`app/PLAN.md`](../app/PLAN.md) — Phase 1, cùng Dashboard và Onboarding.

## Ba tầng — đừng trộn

| Tầng | Cái gì | Quy tắc |
|---|---|---|
| **Cài đặt** | `scripts/reqwise-mcp.sh` + config editor | Cả ba editor trỏ **cùng một đường dẫn tuyệt đối**. Chạy `node scripts/install-mcp-global.mjs` sau khi build hoặc đổi chỗ repo. |
| **Bridge** | Leader trên `localhost:38470` | Process MCP **đầu tiên** = leader (giữ kết nối plugin). Các process sau = **follower** (forward qua `/rpc`). `figma_status.mode` báo `"leader"` hoặc `"follower"` — cả hai vẫn gọi tool bình thường. |
| **Canvas** | Plugin Figma + **channel** | Một cửa sổ Figma = một channel. Nhiều agent có thể cùng bridge; routing tới đúng cửa sổ qua `channel` hoặc **session picker** trong plugin UI. |

## Cài / đồng bộ sau khi sửa code

```bash
cd /path/to/reqwise-figma-mcp
npm run build
node scripts/install-mcp-global.mjs   # hoặc: npm run install:mcp
```

Sau đó **restart** từng editor (hoặc tắt/bật MCP `reqwise-figma`).

### Sửa server (`src/server/`) — leader phải chạy bản mới

Follower forward `figma_write` về leader. Nếu leader còn process cũ trên 38470, code mới **không** có hiệu lực cho write.

```bash
# Ai đang giữ 38470?
lsof -nP -iTCP:38470 -sTCP:LISTEN
# Dừng hết, rồi mở lại MCP từ editor anh muốn làm leader
pkill -f "reqwise-figma-mcp/dist/server/index.js"
```

Editor mở MCP **đầu tiên** sau lệnh trên sẽ elect leader với build vừa build.

### Sửa plugin (`src/plugin/`) — reload plugin trong Figma

Server-side fix áp ngay; plugin-side fix cần **chạy lại** plugin: Figma → Plugins → Development → Reqwise Figma MCP.

## Điều khiển canvas khi nhiều agent

### Một cửa sổ Figma (thường gặp)

Không cần `channel` hay `file`. Mọi agent dùng chung một file; ops xếp hàng FIFO trên connection đó.

### Nhiều cửa sổ Figma — AI tự nắm file/page

Agent **không** hỏi user bấm Connect. Đọc `figma_status.channels` (file, page, `focused`) rồi truyền `file` / `page` (fuzzy: `"klopop"` → `"Klopop official"`, `"flow"` → `"Flows"`). Session **nhớ** target sau lệnh đầu.

- **Khác file** (Klopop vs reqwise-mcp-test) → mỗi file một channel, **chạy song song**.
- **Cùng file, khác page**, mỗi page một cửa sổ (Window → New window) → song song. Pass page (e.g. `"Flows"`).
- **Cùng file + cùng page** → xếp hàng trên một cửa sổ (Plugin API không chịu hai mutation chồng).

Cửa sổ user vừa click (`focused`) là default cho session mới chưa truyền `file`. `channel` id vẫn dùng được, không bắt buộc.

### Nhiều agent, một cửa sổ

- Mỗi MCP process có `mySessionId` trong `figma_status`.
- `figma_write` có thể truyền `sessionId` — `state` persist **theo session trên leader**.
- Hai agent không chia `state` trừ khi cố ý dùng cùng `sessionId`.

## Checklist hàng ngày

1. Figma Desktop + plugin Reqwise bật (đèn xanh).
2. Mở editor(s) cần dùng — MCP tự elect leader/follower.
3. Agent gọi `figma_status` trước khi vẽ; đọc `hints` nếu có lỗi.
4. Sau `npm run build` ở repo MCP: kill leader cũ hoặc restart toàn bộ editor.

## Không nên

| Việc | Hậu quả |
|---|---|
| Mỗi editor một cách spawn (`node dist/...` vs `reqwise-mcp.sh`) | Follower không đọc token discovery → "0 tools" |
| Config per-project thay vì global | Chỉ hoạt động trong một folder |
| Hai leader cùng lúc (hai process bind port khác nhau, hai plugin cohort) | Chỉ khi **cố ý** tách file Figma — không phải default |
| Bỏ qua `figma_status` khi lỗi | Retry mù — đọc `hints` trước |

## Tham chiếu

- Cài đặt chi tiết: [`INSTALL.md`](./INSTALL.md)
- Channel routing: [`ARCHITECTURE.md`](../ARCHITECTURE.md) § Channel routing
- Tool `figma_status`, session state: [`TOOLS.md`](./TOOLS.md)
