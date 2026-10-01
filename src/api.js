/**
 * Xử lý POST /api — chuyển tiếp yêu cầu từ trình duyệt tới Google Apps Script Web App.
 *
 * Biến môi trường (Cloudflare → Worker → Settings → Variables and Secrets):
 *   APPS_SCRIPT_URL : URL Web App dạng https://script.google.com/macros/s/XXXX/exec
 *   PROXY_KEY       : chuỗi bí mật, trùng với Script property PROXY_KEY bên Apps Script (đặt dạng Secret)
 */

const MAX_BODY = 64 * 1024; // 64 KB

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

export async function handleApi(request, env) {
  if (request.method !== "POST") {
    return json({ success: false, code: "METHOD", message: "Chỉ hỗ trợ POST" }, 405);
  }

  if (!env.APPS_SCRIPT_URL || !env.PROXY_KEY) {
    return json({ success: false, code: "CONFIG", message: "Máy chủ chưa cấu hình APPS_SCRIPT_URL / PROXY_KEY" }, 500);
  }

  // Chỉ nhận yêu cầu từ chính trang web này
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) {
    return json({ success: false, code: "FORBIDDEN", message: "Nguồn yêu cầu không hợp lệ" }, 403);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY) {
    return json({ success: false, code: "TOO_LARGE", message: "Dữ liệu gửi lên quá lớn" }, 413);
  }

  let body;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return json({ success: false, code: "BAD_REQUEST", message: "Yêu cầu không hợp lệ" }, 400);
  }
  if (typeof body.action !== "string") {
    return json({ success: false, code: "BAD_REQUEST", message: "Thiếu action" }, 400);
  }

  const payload = {
    action: body.action,
    args: body.args && typeof body.args === "object" ? body.args : {},
    token: typeof body.token === "string" ? body.token : null,
    proxyKey: env.PROXY_KEY,
    clientIp: request.headers.get("CF-Connecting-IP") || "",
  };

  let upstream;
  try {
    // Apps Script trả 302 → googleusercontent.com; fetch tự theo redirect bằng GET (đúng như Apps Script yêu cầu)
    upstream = await fetch(env.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow",
    });
  } catch (e) {
    return json({ success: false, code: "UPSTREAM", message: "Không kết nối được Google Apps Script" }, 502);
  }

  const text = await upstream.text();
  try {
    JSON.parse(text);
  } catch {
    return json(
      {
        success: false,
        code: "UPSTREAM",
        message:
          "Apps Script không trả về JSON (HTTP " + upstream.status + "). " +
          "Kiểm tra lại URL Web App và quyền truy cập 'Anyone' khi deploy.",
      },
      502
    );
  }

  return new Response(text, {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
