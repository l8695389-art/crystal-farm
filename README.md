# Đào Đá Quý — Telegram Mini App (Cloudflare Workers + D1)

Game tap-to-earn, dữ liệu người chơi lưu trong Cloudflare D1 (SQLite),
phục vụ qua Cloudflare Workers (kèm static assets, không cần build step).

## Cấu trúc

```
crystal-tap-game/
├── wrangler.toml          # cấu hình Worker + D1 + static assets
├── migrations/
│   └── 0001_init.sql      # schema bảng players
├── src/
│   └── worker.js          # API: /api/player, /api/leaderboard
└── public/
    ├── index.html          # giao diện game
    └── app.js              # logic game (vanilla JS, gọi API)
```

## Triển khai

### 1. Cài Wrangler và đăng nhập

```bash
npm install -g wrangler
wrangler login
```

### 2. Tạo database D1

```bash
cd crystal-tap-game
wrangler d1 create crystal_tap_db
```

Lệnh trên trả về một `database_id` — copy giá trị đó vào `wrangler.toml`,
thay cho `REPLACE_WITH_YOUR_D1_DATABASE_ID`.

### 3. Chạy migration để tạo bảng

```bash
# kiểm tra local trước
wrangler d1 execute crystal_tap_db --local --file=./migrations/0001_init.sql

# áp dụng lên database thật
wrangler d1 execute crystal_tap_db --remote --file=./migrations/0001_init.sql
```

### 4. (Khuyến nghị) Bật xác thực dữ liệu Telegram

Lấy bot token từ [@BotFather](https://t.me/BotFather), rồi:

```bash
wrangler secret put BOT_TOKEN
```

Nếu bỏ qua bước này, app vẫn chạy bình thường nhưng server sẽ không xác minh
request thực sự đến từ Telegram (phù hợp khi test, không khuyến nghị cho production).

### 5. Deploy

```bash
wrangler deploy
```

Wrangler sẽ in ra URL dạng `https://crystal-tap-game.<subdomain>.workers.dev`.

### 6. Đăng ký Mini App với BotFather

Trong Telegram, chat với **@BotFather**:

1. `/newapp` (hoặc `/setmenubutton` nếu bot đã tồn tại)
2. Chọn bot của bạn
3. Nhập URL Worker vừa deploy ở bước 5 làm **Web App URL**

Mở bot trên Telegram và bấm nút Mini App để chơi thử.

### 7. Bật trả lời tự động khi người dùng gõ /start

Bot sẽ tự trả lời chào mừng kèm nút "Chơi ngay" mỗi khi ai đó bấm **Start**
hoặc gõ `/start` trong chat với bot.

1. Điền đúng URL Worker vào `MINI_APP_URL` trong `wrangler.toml`, rồi deploy lại:
   ```bash
   wrangler deploy
   ```
2. Đảm bảo đã set `BOT_TOKEN` (bước 4) — bot cần token này để gửi tin nhắn.
3. Đăng ký webhook để Telegram gửi các cập nhật (bao gồm /start) tới Worker:
   ```bash
   curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
     -d "url=https://<worker-url>/webhook" \
     -d "secret_token=<WEBHOOK_SECRET nếu bạn có đặt>"
   ```
4. Kiểm tra webhook đã đăng ký đúng:
   ```bash
   curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
   ```

Từ giờ, mở chat với bot và gõ `/start` sẽ nhận được tin nhắn chào mừng kèm
nút bấm mở thẳng Mini App.

Muốn thêm lệnh khác (`/help`, `/leaderboard`...), sửa hàm `handleTelegramUpdate`
trong `src/worker.js`.

## Local dev

```bash
wrangler dev
```

Mở `http://localhost:8787` — khi chạy ngoài Telegram, app tự tạo một ID
ẩn danh lưu trong `localStorage` của trình duyệt để bạn test được.

## Chỉ mở được trong Telegram

App kiểm tra `Telegram.WebApp.initData` khi tải trang. Nếu mở trực tiếp bằng
trình duyệt thường (không có `initData` hợp lệ), app sẽ hiện màn "Chỉ mở
được trong Telegram" và không gọi bất kỳ API nào.

Ngoại lệ: khi chạy trên `localhost`/`127.0.0.1` (tức là đang `wrangler dev`
để phát triển), app vẫn cho phép mở để tiện test — lúc đó sẽ dùng ID ẩn danh
lưu trong `localStorage` và hỏi nhập tên thủ công như trước.

## Danh tính người chơi

Khi mở trong Telegram, app tự lấy thông tin từ `Telegram.WebApp.initDataUnsafe.user`,
không cần người chơi tự nhập:

- **Ảnh đại diện**: dùng đúng `photo_url` Telegram trả về; nếu không có, hiện
  chữ cái đầu tên làm avatar thay thế.
- **Tên hiển thị**: ưu tiên tên hiển thị Telegram (họ + tên); nếu tài khoản
  không có tên thì dùng `@username`; nếu có cả hai đều thiếu (hiếm), app sẽ
  hỏi nhập tên thủ công.
- Tên/ảnh được đồng bộ lại mỗi lần mở app, để nếu người chơi đổi tên hoặc
  ảnh trên Telegram thì dữ liệu trong game cũng cập nhật theo.
- Khi test ngoài Telegram (mở thẳng bằng trình duyệt), app không có dữ liệu
  Telegram nên sẽ hỏi nhập tên thủ công và không có ảnh đại diện.

Nếu đã từng chạy migration `0001_init.sql` trước khi có 2 cột này, chạy thêm:

```bash
wrangler d1 execute crystal_tap_db --remote --file=./migrations/0002_add_avatar.sql
```

Cài mới hoàn toàn thì chỉ cần chạy `0001_init.sql` (đã có sẵn 2 cột này).

## Cơ chế đồng bộ dữ liệu

- Toàn bộ state của người chơi (xu, năng lượng, chuỗi điểm danh, nhiệm vụ đã nhận...)
  được lưu trong bảng `players` của D1, khoá theo Telegram user ID.
- Năng lượng hồi theo thời gian thực: server tính lại phần hồi khi offline
  dựa trên `last_energy_ts` mỗi khi client gọi `GET /api/player`.
- Bảng xếp hạng lấy trực tiếp từ D1 (`ORDER BY coins DESC LIMIT 10`),
  không cần bảng riêng.
- Ghi dữ liệu được debounce ở client (500ms sau lần thay đổi cuối) để giảm
  số lần gọi API.

## Nâng cấp gợi ý

- Thêm rate-limit ở endpoint `/api/player` (Cloudflare Rate Limiting) để
  chống spam tap từ client bị chỉnh sửa.
- Thêm bảng `taps_log` nếu cần chống gian lận nghiêm ngặt hơn (xác thực số
  lần tap tối đa theo thời gian ở phía server thay vì tin client).
- Dùng Durable Objects thay D1 nếu cần state realtime nhiều người chơi cùng lúc.
