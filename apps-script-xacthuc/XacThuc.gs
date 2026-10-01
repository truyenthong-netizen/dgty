/**
 * ============================================================
 * XÁC THỰC TÀI KHOẢN GOOGLE — Apps Script RIÊNG (không phải Code.gs)
 * ============================================================
 * Deploy dạng Web app với:
 *   Execute as        : User accessing the web app   (chạy dưới quyền người đăng nhập)
 *   Who has access    : Anyone with Google account
 *
 * Script chỉ đọc email của người đang đăng nhập Google, ký một "vé" (ticket)
 * có hạn 5 phút rồi đưa người dùng quay lại trang đánh giá.
 * Script KHÔNG truy cập Sheets, Drive hay dữ liệu nào khác.
 *
 * Script Properties (Project Settings → Script properties):
 *   VERIFY_SECRET : chuỗi bí mật, TRÙNG với biến VERIFY_SECRET trên Cloudflare
 *   RETURN_URLS   : địa chỉ trang đánh giá, ví dụ https://dgty.tccb.workers.dev
 *                   (nhiều địa chỉ cách nhau dấu phẩy)
 * ============================================================
 */

const TICKET_TTL_SEC = 5 * 60;

function doGet(e) {
  const props = PropertiesService.getScriptProperties();
  const secret = props.getProperty("VERIFY_SECRET");
  const returns = String(props.getProperty("RETURN_URLS") || "")
    .split(",").map(function (s) { return s.trim().replace(/\/+$/, ""); }).filter(Boolean);

  if (!secret || !returns.length) {
    return page_("⚠️ Chưa cấu hình", "Thiếu Script property VERIFY_SECRET hoặc RETURN_URLS.", null);
  }

  // Chỉ quay về các địa chỉ đã khai báo (tránh lộ vé sang trang lạ)
  const asked = String((e && e.parameter && e.parameter.r) || "").replace(/\/+$/, "");
  const back = returns.indexOf(asked) >= 0 ? asked : returns[0];

  // Link "Dùng tài khoản khác": đăng xuất Google rồi quay lại chính trang này
  let switchUrl = "";
  try {
    // Bỏ phần "/a/macros/<tên miền>/" để trang đăng nhập nhận mọi tài khoản Google (kể cả Gmail)
    const selfUrl = String(ScriptApp.getService().getUrl() || "").replace(/\/a\/macros\/[^/]+\//, "/macros/");
    if (selfUrl) switchUrl = "https://accounts.google.com/Logout?continue=" +
      encodeURIComponent(selfUrl + "?r=" + encodeURIComponent(back));
  } catch (err) { /* không lấy được URL → ẩn nút đổi tài khoản */ }

  const email = String(Session.getActiveUser().getEmail() || "").trim().toLowerCase();
  if (!email) {
    return page_("⚠️ Không đọc được email",
      "Google không cung cấp email của tài khoản này. Vui lòng thử lại bằng cửa sổ ẩn danh.", back, switchUrl);
  }

  const now = Math.floor(Date.now() / 1000);
  const body = Utilities.base64EncodeWebSafe(
    JSON.stringify({ email: email, iat: now, exp: now + TICKET_TTL_SEC, n: Utilities.getUuid() }),
    Utilities.Charset.UTF_8
  ).replace(/=+$/, "");
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(body, secret)).replace(/=+$/, "");

  return page_("✅ Đã xác thực tài khoản Google", email, back + "/#gticket=" + body + "." + sig, switchUrl);
}

function esc_(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function page_(title, detail, url, switchUrl) {
  const ok = url && url.indexOf("#gticket=") > 0;
  const html =
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>' +
    'body{margin:0;font-family:Arial,sans-serif;background:linear-gradient(135deg,#0f2557,#1e40af);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}' +
    '.c{background:#fff;border-radius:16px;padding:32px 26px;max-width:420px;width:100%;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,.25)}' +
    'h1{font-size:18px;color:#0f2557;margin:0 0 12px}' +
    '.e{font-size:16px;font-weight:bold;color:#1e293b;word-break:break-all;margin-bottom:22px}' +
    'a.b{display:block;background:#1a56db;color:#fff;text-decoration:none;font-weight:bold;padding:14px;border-radius:8px;font-size:15px}' +
    'p{font-size:12px;color:#64748b;line-height:1.6;margin:18px 0 0}' +
    'a.s{display:block;margin-top:12px;padding:12px;border:1.5px solid #dadce0;border-radius:8px;color:#1a56db;text-decoration:none;font-weight:bold;font-size:14px}' +
    '</style></head><body><div class="c">' +
    '<h1>' + esc_(title) + '</h1>' +
    '<div class="e">' + esc_(detail) + '</div>' +
    (url ? '<a class="b" href="' + esc_(url) + '" target="_top">' + (ok ? 'TIẾP TỤC →' : '← Quay lại') + '</a>' : '') +
    (switchUrl ? '<a class="s" href="' + esc_(switchUrl) + '" target="_top">Dùng tài khoản Google khác</a>' : '') +
    (switchUrl ? '<p>"Dùng tài khoản Google khác" sẽ đăng xuất mọi tài khoản Google trên trình duyệt này, sau đó Quý Thầy/Cô đăng nhập lại bằng tài khoản muốn dùng. ' +
                 'Nếu không muốn đăng xuất, hãy mở trang đánh giá bằng cửa sổ ẩn danh.</p>' : '') +
    '</div></body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle("Xác thực tài khoản Google")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}
