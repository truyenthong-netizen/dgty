# Phiếu tự đánh giá VC-NLĐ — Đại học Y Dược TP. HCM

Web app đánh giá hiệu quả công việc hằng tháng cho VC-NLĐ khối hành chính, hỗ trợ, phục vụ.

```
Trình duyệt ──► Cloudflare Worker (src/worker.js)
                     │  /        → file tĩnh public/index.html
                     │  POST /api
                     ▼
               src/api.js  ── thêm PROXY_KEY + IP người dùng
                     │
                     ▼
               Google Apps Script Web App (apps-script/Code.gs)
                     │
                     ▼
               Google Sheets (DanhSachNhanSu, DuLieuDanhGia, LichSuDangNhap)
```

Google Sheets vẫn là nơi lưu dữ liệu. Apps Script chỉ còn làm API; giao diện chạy trên Cloudflare.

## Cấu trúc thư mục

| Đường dẫn | Nội dung |
|---|---|
| `public/index.html` | Toàn bộ giao diện (HTML + CSS + JS) |
| `public/_headers` | Header bảo mật cho file tĩnh |
| `src/worker.js` | Điểm vào Worker: `/api` → proxy, còn lại → file tĩnh |
| `src/api.js` | Proxy `/api` → Apps Script |
| `apps-script/Code.gs` | Backend, dán vào Apps Script của file Google Sheets |
| `wrangler.toml` | Cấu hình Cloudflare Worker |

---

## Bước 1 — Cập nhật Google Apps Script

1. Mở file Google Sheets → **Tiện ích mở rộng → Apps Script**.
2. Thay toàn bộ nội dung `Code.gs` bằng file `apps-script/Code.gs` trong repo này.
3. **Xóa file `Index.html`** trong Apps Script (giao diện giờ nằm trên Cloudflare).
4. Vào **Project Settings (⚙️) → Script properties → Add script property**:
   - `PROXY_KEY` = một chuỗi bí mật dài, ví dụ tạo bằng https://www.uuidgenerator.net (ghi lại để dùng ở Bước 3).
5. Chạy các hàm quản trị **một lần** (chọn tên hàm trên thanh công cụ → ▶ Run, cấp quyền khi được hỏi):
   - `backfillMsnv` — điền cột **Y (MSNV)** cho các phiếu cũ. Hàm sẽ liệt kê những dòng trùng tên không tự xác định được; điền tay MSNV cho các dòng đó.
   - `fixThangDanhGia` — chuẩn hóa cột B về dạng `MM-YYYY`.
6. **Deploy → New deployment → Web app**:
   - *Execute as*: **Me**
   - *Who has access*: **Anyone**
   - Bấm Deploy, sao chép **Web app URL** (dạng `https://script.google.com/macros/s/.../exec`).

> Khi sửa `Code.gs` sau này: **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. URL giữ nguyên.

## Bước 2 — Đưa code lên GitHub

```bash
cd vcnld-danhgia
git init -b main
git add .
git commit -m "Phiếu tự đánh giá VC-NLĐ — Cloudflare Pages + Apps Script"
git remote add origin https://github.com/<tai-khoan>/vcnld-danhgia.git
git push -u origin main
```

(Tạo repo trống `vcnld-danhgia` trên GitHub trước, nên để **Private**.)

## Bước 3 — Triển khai lên Cloudflare (Workers)

1. Mở `wrangler.toml`, sửa dòng `name = "vcnld-danhgia"` cho **trùng tên Worker** trên Cloudflare, rồi commit và push.
2. Vào https://dash.cloudflare.com → **Workers & Pages → Create → Import a repository** → chọn repo.
   - *Build command*: để trống
   - *Deploy command*: `npx wrangler deploy` (mặc định)
3. Vào Worker → **Settings → Variables and Secrets → Add**:
   - `APPS_SCRIPT_URL` = Web app URL ở Bước 1.6 (kiểu *Text*)
   - `PROXY_KEY` = cùng chuỗi đã đặt ở Bước 1.4 (kiểu **Secret**)
4. Vào **Deployments** → chạy lại bản build (hoặc push một commit mới). Trang chạy tại `https://<ten-worker>.<tai-khoan>.workers.dev`; có thể gắn tên miền riêng ở **Settings → Domains & Routes**.

Từ đó mỗi lần `git push` lên nhánh `main`, Cloudflare tự triển khai lại. `wrangler.toml` có `keep_vars = true` nên các biến đặt trên dashboard không bị xóa khi deploy.

### Chạy thử trên máy (tùy chọn)

```bash
cp .dev.vars.example .dev.vars   # rồi điền URL + PROXY_KEY thật
npx wrangler dev
```

---

## Thay đổi so với bản cũ

**Chọn tháng**
- Bỏ `<input type="month">` (Safari cũ, Firefox desktop… không hiển thị được, người dùng phải gõ tay nên sai định dạng).
- Thay bằng 2 ô chọn **Tháng / Năm**, chạy trên mọi trình duyệt; các tháng tương lai bị khóa.
- Backend chuẩn hóa mọi kiểu tháng (`09-2026`, `9/2026`, `2026-09`, ô bị Sheets đổi thành ngày…) về `MM-YYYY`, nên dữ liệu cũ gõ sai vẫn được nhận đúng.

**Dữ liệu**
- Chặn gửi trùng ở backend (có khóa `LockService`), không chỉ kiểm tra ở giao diện.
- Nhận diện người dùng theo **MSNV** (cột Y mới) thay vì họ tên → hai người trùng tên không còn bị lẫn phiếu/lịch sử.
- Trưởng đơn vị lưu điểm: kiểm tra lại đúng người, đúng đơn vị, đúng tháng trước khi ghi; nếu sheet đã bị sắp xếp/xóa dòng thì tự tìm lại dòng đúng.
- Điểm 0 hiển thị là `0` (trước đây bị trống).
- Backend tự tính lại điểm và kiểm tra từng mức điểm hợp lệ; họ tên/đơn vị lấy từ phiên đăng nhập, không tin dữ liệu gửi lên.

**Bảo mật**
- Đăng nhập cấp token có chữ ký (hết hạn sau 8 giờ); mọi thao tác đều kiểm tra token và vai trò ở backend. Dữ liệu toàn trường và xuất báo cáo chỉ dành cho vai trò HR; bảng chấm chỉ dành cho Trưởng đơn vị của chính đơn vị đó.
- Apps Script chỉ nhận yêu cầu có `PROXY_KEY` (chỉ Cloudflare biết).
- Khóa đăng nhập 15 phút sau 10 lần nhập sai mã số từ cùng một IP.
- Mọi dữ liệu hiển thị đều được escape (ghi chú có dấu `"`, `<`… không làm vỡ giao diện).

**Chức năng**
- Trưởng đơn vị và HR có thêm trang **Tự đánh giá** và **Kết quả & lịch sử** của chính mình.
- Bỏ cột "Chức danh" luôn trống trong file CSV; CSV và Excel dùng cùng bộ cột.
- Có thể đăng nhập bằng CCCD mất số 0 ở đầu (do Sheets lưu dạng số).
- Tải lại trang không bị đăng xuất (phiên lưu trong tab trình duyệt).

## Xử lý sự cố

| Thông báo | Cách xử lý |
|---|---|
| *Máy chủ chưa cấu hình APPS_SCRIPT_URL / PROXY_KEY* | Thêm biến ở Worker → Settings → Variables and Secrets |
| Build báo tên Worker không khớp | Sửa `name` trong `wrangler.toml` cho trùng tên Worker trên dashboard |
| *Máy chủ chưa cấu hình PROXY_KEY (Script properties)* | Thêm `PROXY_KEY` ở Apps Script (Bước 1.4) |
| *Không có quyền truy cập* | `PROXY_KEY` hai bên chưa trùng nhau |
| *Apps Script không trả về JSON* | Sai URL Web App, hoặc chưa đặt *Who has access = Anyone* |
| Sửa `Code.gs` nhưng không thấy thay đổi | Chưa tạo **New version** khi deploy |
