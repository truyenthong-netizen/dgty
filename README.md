# Phiếu tự đánh giá VC-NLĐ — Đại học Y Dược TP. HCM

Web app đánh giá hiệu quả công việc hằng tháng cho VC-NLĐ khối hành chính, hỗ trợ, phục vụ.

```
Trình duyệt ──► Cloudflare Worker (src/worker.js)
                     │  /        → file tĩnh public/index.html
                     │  POST /api
                     ▼
               src/api.js  ── kiểm tra vé xác thực Google (src/ticket.js), thêm PROXY_KEY + IP + email đã xác thực
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
| `src/ticket.js` | Kiểm tra vé xác thực Google |
| `apps-script-xacthuc/` | Apps Script **riêng** để xác thực tài khoản Google (XacThuc.gs + appsscript.json) |
| `apps-script/Code.gs` | Backend, dán vào Apps Script của file Google Sheets |
| `wrangler.toml` | Cấu hình Cloudflare Worker |

## Đăng nhập 2 bước (Google + Mã số/CCCD)

1. Người dùng bấm **Xác thực bằng Google** → chuyển sang Apps Script xác thực (chạy dưới quyền chính người đó) → Google cho biết email đang đăng nhập → Apps Script ký một **vé** có hạn 5 phút và đưa người dùng quay lại. Worker kiểm tra chữ ký vé bằng `VERIFY_SECRET`.
2. Người dùng nhập **mã số/CCCD**. Apps Script đối chiếu email Google với cột **Email** trong `DanhSachNhanSu`:
   - Cột Email **trống** → lần đăng nhập đầu tiên **gắn** email đó vào mã số (mọi dòng của mã số, kể cả trưởng đơn vị có 2 đơn vị).
   - Cột Email **đã có** → bắt buộc đúng email đó; sai thì từ chối và ghi nhật ký `❌ Email Google không khớp mã số`.
   - Một email không thể gắn cho hai mã số khác nhau.
3. Nhật ký `LichSuDangNhap` có thêm cột **Email Google** và **IP**; mỗi phiếu đánh giá có thêm cột **Z – EmailGoogle** của người nộp.

**Quản trị email** (Phòng TCCB, làm trực tiếp trên sheet `DanhSachNhanSu`):
- Nhân sự đổi email / gắn nhầm → xóa ô Email của người đó, lần đăng nhập sau sẽ gắn lại.
- Muốn kiểm soát chặt hơn → điền sẵn email cho từng người, rồi đặt Script property `EMAIL_POLICY = strict` (mã số chưa có email sẽ không đăng nhập được).
- Chỉ nhận email trường → Script property `ALLOWED_EMAIL_DOMAINS = ump.edu.vn` (nhiều tên miền cách nhau dấu phẩy).

### Tạo Apps Script xác thực (làm 1 lần, không cần Google Cloud Console)

Đăng nhập bằng **tccb@uphcm.edu.vn** (tài khoản sở hữu file Google Sheets).

1. Vào https://script.google.com → **Dự án mới**. Đặt tên `dgty-xacthuc`.
2. Xóa nội dung `Code.gs` mặc định, dán toàn bộ file `apps-script-xacthuc/XacThuc.gs`.
3. **Cài đặt dự án (⚙️)** → tích **Hiển thị tệp kê khai "appsscript.json" trong trình chỉnh sửa**. Quay lại **Trình chỉnh sửa**, mở `appsscript.json`, thay toàn bộ bằng file `apps-script-xacthuc/appsscript.json`. Lưu (Ctrl+S).
4. **Cài đặt dự án (⚙️) → Thuộc tính tập lệnh → Thêm**:
   - `VERIFY_SECRET` = một chuỗi bí mật dài, **khác** `PROXY_KEY` (ghi lại để dán vào Cloudflare).
   - `RETURN_URLS` = `https://dgty.tccb.workers.dev`
5. **Triển khai → Tùy chọn triển khai mới → Ứng dụng web**:
   - *Thực thi với tư cách*: **Người dùng truy cập ứng dụng web**
   - *Người có quyền truy cập*: **Bất kỳ ai có Tài khoản Google**
   - Bấm **Triển khai**, cấp quyền khi được hỏi, sao chép **URL ứng dụng web** (…/exec).
6. Cloudflare → Worker → **Settings → Runtime variables and secrets**:
   - `VERIFY_URL` = URL ở bước 5 (kiểu *Text*)
   - `VERIFY_SECRET` = chuỗi ở bước 4 (kiểu **Secret**)

Lần đầu mỗi người xác thực, Google hỏi cho phép ứng dụng **"Xem địa chỉ email chính của bạn"** → bấm **Cho phép**. Đây là quyền duy nhất script xin; script không đọc được Drive, Gmail hay Sheets của người dùng.

> Người dùng Gmail cá nhân (không phải @uphcm.edu.vn) sẽ thấy cảnh báo *"Google chưa xác minh ứng dụng này"* ở lần đầu → bấm **Nâng cao → Đi tới dgty-xacthuc**. Người dùng email trường không gặp cảnh báo này.

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
   - `VERIFY_URL`, `VERIFY_SECRET` = theo mục *Tạo Apps Script xác thực*
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
- Đăng nhập 2 bước: tài khoản Google + mã số/CCCD; email được gắn với mã số và ghi vào nhật ký.
- Khóa đăng nhập 15 phút sau 10 lần sai từ cùng một IP **hoặc** cùng một email Google.
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
| *Máy chủ chưa cấu hình VERIFY_URL / VERIFY_SECRET* | Thêm biến ở Worker (runtime) |
| *Xác thực Google không hợp lệ* ngay sau khi quay về | `VERIFY_SECRET` ở Cloudflare và ở Apps Script xác thực chưa trùng nhau |
| Trang xác thực báo *"Rất tiếc, hiện không thể mở tệp"* | Trình duyệt đang đăng nhập **nhiều tài khoản Google** (lỗi đã biết của Apps Script) → dùng cửa sổ ẩn danh, hoặc đăng xuất bớt tài khoản |
| Xác thực ra **sai email** | Trình duyệt chọn tài khoản Google mặc định → dùng cửa sổ ẩn danh và đăng nhập đúng tài khoản |
| Quay về trang nhưng báo *Chưa cấu hình RETURN_URLS* | Thêm `RETURN_URLS` ở Apps Script xác thực |
| *Tài khoản Google … không khớp với mã số này* | Người dùng chọn sai email; nếu họ đã đổi email, xóa ô Email của họ trong `DanhSachNhanSu` |
| *… đã được dùng cho một nhân sự khác* | Email đó đã gắn với mã số khác; kiểm tra cột Email trong `DanhSachNhanSu` |
