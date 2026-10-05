/**
 * ============================================================
 * HỆ THỐNG ĐÁNH GIÁ VC-NLĐ — BACKEND API (Google Apps Script)
 * ============================================================
 * Frontend chạy trên Cloudflare Pages, gọi về đây qua
 * Pages Function /api  →  doPost (JSON).
 *
 * Script Properties (Project Settings → Script properties):
 *   PROXY_KEY    : BẮT BUỘC — chuỗi bí mật, trùng với biến PROXY_KEY trên Cloudflare
 *   TOKEN_SECRET : tự sinh ở lần gọi đầu tiên nếu chưa có
 *
 * Sheet DanhSachNhanSu cần cột "Email" cho Trưởng đơn vị và HR
 * (dùng để gửi mã OTP khi đăng nhập).
 *
 * Cột sheet DuLieuDanhGia:
 *   A ThoiGian | B ThangDanhGia (MM-YYYY, text) | C HoTen | D DonVi
 *   E-G 1.1-1.3 | H-R 11 điểm thành phần | S Tổng | T Xếp loại | U Ghi chú A+
 *   V-X Trưởng đơn vị (điểm, loại, ghi chú) | Y MSNV (mới)
 * ============================================================
 */

const SHEET_NHANSU  = "DanhSachNhanSu";
const SHEET_DANHGIA = "DuLieuDanhGia";
const SHEET_LOGIN   = "LichSuDangNhap";
const TZ            = "Asia/Ho_Chi_Minh";

const COL = {
  THOIGIAN:     0,   // A
  THANGDANHGIA: 1,   // B ← MM-YYYY
  HOTEN:        2,   // C
  DONVI:        3,   // D
  DIEM_1_1:     4,   // E
  DIEM_1_2:     5,   // F
  DIEM_1_3:     6,   // G
  DIEM_2_1:     7,   // H (H-R: 11 điểm thành phần)
  TONGDIEM:     18,  // S
  XEPLOAI:      19,  // T
  GHICHU:       20,  // U
  SEPDIEM:      21,  // V
  SEPLOAI:      22,  // W
  SEPGHICHU:    23,  // X
  MSNV:         24   // Y
};
const TOTAL_COLS = 25;

const TOKEN_TTL_SEC   = 8 * 60 * 60;   // phiên đăng nhập 8 giờ
const LOGIN_MAX_FAIL  = 10;            // sai quá 10 lần / IP ...
const LOGIN_BLOCK_SEC = 15 * 60;       // ... thì khóa 15 phút

// OTP qua email cho Trưởng đơn vị / HR
const OTP_TTL_SEC        = 5 * 60;     // mã có hiệu lực 5 phút
const OTP_MAX_ATTEMPTS   = 5;          // nhập sai 5 lần → phải đăng nhập lại
const OTP_RESEND_COOLDOWN = 120;       // gửi lại mã sau tối thiểu 120 giây
const OTP_MAX_RESEND     = 3;          // mỗi lượt đăng nhập gửi lại tối đa 3 lần
const OTP_MAX_PER_USER   = 6;          // mỗi người tối đa 6 email OTP / 15 phút (chống spam hộp thư)
const PRIVILEGED_ROLES   = ["manager", "hr"];

const SCORE_RULES = {
  diem_2_1: { label: "2.1", allowed: [0, 3] },
  diem_2_2: { label: "2.2", allowed: [0, 1, 2, 3] },
  diem_2_3: { label: "2.3", allowed: [0, 1, 2, 3] },
  diem_2_4: { label: "2.4", allowed: [0, 1, 2, 3] },
  diem_2_5: { label: "2.5", allowed: [0, 1, 2, 3] },
  diem_3_1: { label: "3.1", allowed: range_(0, 6, 0.5) },
  diem_3_2: { label: "3.2", allowed: range_(0, 4, 0.5) },
  diem_3_3: { label: "3.3", allowed: range_(0, 5, 0.5) },
  diem_4_1: { label: "4.1", allowed: [0, 14, 15, 16, 17, 18, 18.5, 19, 19.5, 20] },
  diem_4_2: { label: "4.2", allowed: [0, 12, 13, 14, 15, 16, 17, 18, 19, 20] },
  diem_4_3: { label: "4.3", allowed: [0, 22, 23, 24, 25, 26, 27, 28, 29, 30] }
};
const SCORE_KEYS = Object.keys(SCORE_RULES);

const REPORT_HEADERS = [
  "STT", "Họ và tên", "Đơn vị",
  "1.1", "1.2", "1.3", "2.1", "2.2", "2.3", "2.4", "2.5",
  "3.1", "3.2", "3.3", "4.1", "4.2", "4.3",
  "Tổng điểm", "Tự xếp loại", "Ghi chú A+",
  "Điểm TĐV", "TĐV xếp loại", "Ghi chú TĐV"
];

// auth: null = không cần đăng nhập | "any" = mọi vai trò | "manager" | "hr"
const ROUTES = {
  login:                    { auth: null,      fn: login_ },
  verifyOtp:                { auth: null,      fn: verifyOtp_ },
  resendOtp:                { auth: null,      fn: resendOtp_ },
  checkDoubleEntry:         { auth: "any",     fn: checkDoubleEntry_ },
  saveData:                 { auth: "any",     fn: saveData_ },
  getUserHistory:           { auth: "any",     fn: getUserHistory_ },
  getStaffData:             { auth: "manager", fn: getStaffData_ },
  updateManagerEvaluations: { auth: "manager", fn: updateManagerEvaluations_ },
  getAllStaffData:          { auth: "hr",      fn: getAllStaffData_ },
  exportReport:             { auth: "hr",      fn: exportReport_ },
  exportCSVData:            { auth: "hr",      fn: exportCSVData_ },
  exportExcelData:          { auth: "hr",      fn: exportExcelData_ }
};

// ============================================================
// ĐIỂM VÀO WEB APP
// ============================================================
function doGet() {
  return json_({ success: true, data: { service: "VC-NLD API", time: new Date().toISOString() } });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    return json_({ success: false, message: "Yêu cầu không hợp lệ", code: "BAD_REQUEST" });
  }

  try {
    checkProxyKey_(req.proxyKey);
    const route = ROUTES[req.action];
    if (!route) throw appError_("Hành động không hợp lệ", "BAD_ACTION");

    let user = null;
    if (route.auth) {
      user = verifyToken_(req.token);
      if (route.auth !== "any" && user.role !== route.auth)
        throw appError_("Bạn không có quyền thực hiện thao tác này", "FORBIDDEN");
    }

    const data = route.fn(req.args || {}, user, req);
    return json_({ success: true, data: data === undefined ? null : data });
  } catch (err) {
    if (err && err.isAppError) return json_({ success: false, message: err.message, code: err.code || "" });
    console.error(err && err.stack ? err.stack : err);
    return json_({ success: false, message: "Lỗi hệ thống: " + (err && err.message ? err.message : err), code: "SERVER" });
  }
}

// ============================================================
// 1. ĐĂNG NHẬP
//    VC-NLĐ: nhập mã số là vào.
//    Trưởng đơn vị / HR: nhập mã số → hệ thống gửi OTP 6 số về email
//    (cột "Email" trong DanhSachNhanSu) → nhập đúng OTP mới được cấp phiên.
// ============================================================
function login_(args, _user, req) {
  const msnv = str_(args.msnv);
  const ctx  = clientCtx_(req, args);
  if (!msnv) throw appError_("Vui lòng nhập mã số", "BAD_INPUT");
  checkRateLimit_(ctx.ip);

  const matches = findStaff_(msnv);
  if (!matches.length) {
    registerFail_(ctx.ip);
    logLogin_(ctx, { msnv: msnv, hoTen: "(Không tìm thấy)", donVi: "(Không tìm thấy)", role: "" }, "❌ Sai mã số");
    throw appError_("Mã số không tồn tại!", "NOT_FOUND");
  }

  let chosen;
  if (matches.length > 1) {
    const hasIdx = args.unitIndex !== undefined && args.unitIndex !== null && args.unitIndex !== "";
    if (!hasIdx) {
      return {
        multiUnit: true,
        hoTen: matches[0].hoTen,
        donViList: matches.map(m => ({ donVi: m.donVi, role: m.role }))
      };
    }
    const idx = parseInt(args.unitIndex, 10);
    if (isNaN(idx) || idx < 0 || idx >= matches.length) throw appError_("Đơn vị không hợp lệ", "BAD_INPUT");
    chosen = matches[idx];
  } else {
    chosen = matches[0];
  }

  const user = { msnv: chosen.msnv, hoTen: chosen.hoTen, donVi: chosen.donVi, role: chosen.role };

  // Người có vai trò Trưởng đơn vị / HR ở BẤT KỲ đơn vị nào đều phải qua OTP,
  // kể cả khi đang chọn vai trò VC-NLĐ.
  const privileged = matches.some(m => PRIVILEGED_ROLES.indexOf(m.role) >= 0);
  if (!privileged) {
    logLogin_(ctx, user, "✅ Thành công");
    return { multiUnit: false, token: signToken_(user, false), user: user };
  }

  const email = chosen.email || (matches.find(m => isEmail_(m.email)) || {}).email || "";
  if (!isEmail_(email)) {
    logLogin_(ctx, user, "⛔ Chưa có email nhận OTP");
    throw appError_("Tài khoản của Quý Thầy/Cô chưa được khai báo email để nhận mã OTP. " +
                    "Vui lòng liên hệ Phòng Tổ chức cán bộ để bổ sung.", "NO_EMAIL");
  }

  checkOtpQuota_(user.msnv);
  const otpId = Utilities.getUuid().replace(/-/g, "");
  const code  = newOtpCode_();
  sendOtpEmail_(email, user, code, ctx);
  putOtp_(otpId, {
    user: user, email: email, hash: otpHash_(otpId, code),
    exp: nowSec_() + OTP_TTL_SEC, sentAt: nowSec_(), attempts: 0, resends: 0, ip: ctx.ip
  });
  logLogin_(ctx, user, "📧 Đã gửi OTP", "Gửi tới " + maskEmail_(email), otpId);

  return {
    multiUnit: false, otpRequired: true, otpId: otpId,
    maskedEmail: maskEmail_(email), expiresIn: OTP_TTL_SEC, resendAfter: OTP_RESEND_COOLDOWN
  };
}

function verifyOtp_(args, _user, req) {
  const ctx   = clientCtx_(req, args);
  const otpId = str_(args.otpId);
  const code  = str_(args.code).replace(/\s+/g, "");
  checkRateLimit_(ctx.ip);
  if (!/^[a-f0-9]{32}$/.test(otpId)) throw appError_("Phiên xác thực không hợp lệ, vui lòng đăng nhập lại", "OTP_EXPIRED");
  if (!/^\d{6}$/.test(code)) throw appError_("Mã OTP gồm 6 chữ số", "BAD_INPUT");

  return withLock_(() => {
    const rec = getOtp_(otpId);
    if (!rec) throw appError_("Mã OTP đã hết hạn, vui lòng đăng nhập lại", "OTP_EXPIRED");
    const ipNote = rec.ip && ctx.ip && rec.ip !== ctx.ip ? "IP khác lúc gửi mã (" + rec.ip + ")" : "";

    if (nowSec_() > rec.exp) {
      delOtp_(otpId);
      logLogin_(ctx, rec.user, "⌛ OTP hết hạn", ipNote, otpId);
      throw appError_("Mã OTP đã hết hạn, vui lòng đăng nhập lại", "OTP_EXPIRED");
    }

    if (otpHash_(otpId, code) !== rec.hash) {
      rec.attempts++;
      registerFail_(ctx.ip);
      const left = OTP_MAX_ATTEMPTS - rec.attempts;
      if (left <= 0) {
        delOtp_(otpId);
        logLogin_(ctx, rec.user, "❌ Sai OTP quá số lần", ipNote, otpId);
        throw appError_("Nhập sai mã OTP quá nhiều lần. Vui lòng đăng nhập lại.", "OTP_EXPIRED");
      }
      putOtp_(otpId, rec);
      logLogin_(ctx, rec.user, "❌ Sai OTP", ["Còn " + left + " lần thử", ipNote].filter(Boolean).join(" · "), otpId);
      throw appError_("Mã OTP không đúng. Còn " + left + " lần thử.", "OTP_WRONG");
    }

    delOtp_(otpId);
    logLogin_(ctx, rec.user, "✅ Thành công (OTP)", ipNote, otpId);
    return { token: signToken_(rec.user, true), user: rec.user };
  });
}

function resendOtp_(args, _user, req) {
  const ctx   = clientCtx_(req, args);
  const otpId = str_(args.otpId);
  checkRateLimit_(ctx.ip);
  if (!/^[a-f0-9]{32}$/.test(otpId)) throw appError_("Phiên xác thực không hợp lệ, vui lòng đăng nhập lại", "OTP_EXPIRED");

  return withLock_(() => {
    const rec = getOtp_(otpId);
    if (!rec) throw appError_("Phiên xác thực đã hết hạn, vui lòng đăng nhập lại", "OTP_EXPIRED");
    const wait = OTP_RESEND_COOLDOWN - (nowSec_() - rec.sentAt);
    if (wait > 0) throw appError_("Vui lòng đợi " + wait + " giây rồi gửi lại mã", "OTP_COOLDOWN");
    if (rec.resends >= OTP_MAX_RESEND) {
      delOtp_(otpId);
      throw appError_("Đã gửi lại mã quá số lần cho phép. Vui lòng đăng nhập lại.", "OTP_EXPIRED");
    }

    checkOtpQuota_(rec.user.msnv);
    const code = newOtpCode_();
    sendOtpEmail_(rec.email, rec.user, code, ctx);
    rec.hash     = otpHash_(otpId, code);
    rec.exp      = nowSec_() + OTP_TTL_SEC;
    rec.sentAt   = nowSec_();
    rec.attempts = 0;
    rec.resends++;
    putOtp_(otpId, rec);
    logLogin_(ctx, rec.user, "📧 Gửi lại OTP", "Lần " + rec.resends + " · tới " + maskEmail_(rec.email), otpId);
    return { maskedEmail: maskEmail_(rec.email), expiresIn: OTP_TTL_SEC, resendAfter: OTP_RESEND_COOLDOWN };
  });
}

function findStaff_(msnv) {
  const data = getSheet_(SHEET_NHANSU).getDataRange().getValues();
  const h  = data[0].map(str_);
  const iM = h.indexOf("MSNV"), iH = h.indexOf("HoTen"), iD = h.indexOf("DonVi"), iR = h.indexOf("TRUONG DON VI");
  const iE = h.findIndex(x => /^(e-?mail|mail)\b/i.test(x));
  if (iM < 0 || iH < 0 || iD < 0)
    throw appError_("Sheet " + SHEET_NHANSU + " thiếu cột MSNV / HoTen / DonVi", "CONFIG");

  const out = [];
  for (let i = 1; i < data.length; i++) {
    if (!matchesId_(data[i][iM], msnv)) continue;
    const r = iR >= 0 ? str_(data[i][iR]).toLowerCase() : "";
    const e = iE >= 0 ? str_(data[i][iE]).toLowerCase() : "";
    out.push({
      msnv:  str_(data[i][iM]),
      hoTen: str_(data[i][iH]),
      donVi: str_(data[i][iD]),
      role:  r === "hr" ? "hr" : r === "x" ? "manager" : "staff",
      email: isEmail_(e) ? e : ""
    });
  }
  return out;
}

function checkRateLimit_(ip) {
  if (!ip) return;
  const n = Number(CacheService.getScriptCache().get("loginfail_" + ip) || 0);
  if (n >= LOGIN_MAX_FAIL)
    throw appError_("Bạn đã nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút.", "RATE_LIMIT");
}
function registerFail_(ip) {
  if (!ip) return;
  const cache = CacheService.getScriptCache();
  const key = "loginfail_" + ip;
  cache.put(key, String(Number(cache.get(key) || 0) + 1), LOGIN_BLOCK_SEC);
}

// ============================================================
// OTP — lưu trong CacheService (tự hết hạn), chỉ lưu HMAC của mã
// ============================================================
function newOtpCode_() {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
                                        Utilities.getUuid() + Utilities.getUuid() + Date.now());
  let n = 0;
  for (let i = 0; i < 6; i++) n = (n * 256 + (bytes[i] & 0xff)) % 1000000007;
  return ("00000" + (n % 1000000)).slice(-6);
}
function otpHash_(otpId, code) { return sign_("otp:" + otpId + ":" + code); }
function putOtp_(otpId, rec) {
  CacheService.getScriptCache().put("otp_" + otpId, JSON.stringify(rec), OTP_TTL_SEC + 120);
}
function getOtp_(otpId) {
  const s = CacheService.getScriptCache().get("otp_" + otpId);
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}
function delOtp_(otpId) { CacheService.getScriptCache().remove("otp_" + otpId); }

function checkOtpQuota_(msnv) {
  const cache = CacheService.getScriptCache();
  const key = "otpq_" + normalizeId_(msnv);
  const n = Number(cache.get(key) || 0);
  if (n >= OTP_MAX_PER_USER)
    throw appError_("Đã gửi quá nhiều mã OTP cho tài khoản này. Vui lòng thử lại sau 15 phút.", "RATE_LIMIT");
  cache.put(key, String(n + 1), LOGIN_BLOCK_SEC);
}

function sendOtpEmail_(email, user, code, ctx) {
  const when = Utilities.formatDate(new Date(), TZ, "HH:mm:ss dd/MM/yyyy");
  const rows = [
    ["Thời gian", when],
    ["Thiết bị", [ctx.deviceName, ctx.browser].filter(Boolean).join(" · ")],
    ["Địa chỉ IP", ctx.ip],
    ["Vị trí (ước tính)", ctx.location]
  ].filter(r => r[1]);
  const table = rows.map(r =>
    '<tr><td style="padding:4px 12px 4px 0;color:#64748b;">' + htmlEsc_(r[0]) + '</td>' +
    '<td style="padding:4px 0;color:#0f172a;">' + htmlEsc_(r[1]) + '</td></tr>').join("");
  const mins = Math.round(OTP_TTL_SEC / 60);

  const html =
    '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#0f172a;">' +
      '<h2 style="color:#0f2557;font-size:18px;">Mã xác thực đăng nhập</h2>' +
      '<p>Kính gửi Quý Thầy/Cô <b>' + htmlEsc_(user.hoTen) + '</b>,</p>' +
      '<p>Mã OTP để đăng nhập Hệ thống tự đánh giá VC-NLĐ là:</p>' +
      '<div style="font-size:32px;font-weight:bold;letter-spacing:8px;background:#f1f5f9;' +
           'border-radius:10px;padding:16px;text-align:center;color:#0f2557;">' + code + '</div>' +
      '<p style="font-size:13px;color:#475569;">Mã có hiệu lực trong ' + mins + ' phút và chỉ dùng được một lần. ' +
         'Tuyệt đối không cung cấp mã này cho bất kỳ ai.</p>' +
      '<table style="font-size:13px;margin:12px 0;">' + table + '</table>' +
      '<p style="font-size:13px;background:#fef2f2;border-left:4px solid #dc2626;padding:10px 12px;color:#991b1b;">' +
         '<b>Nếu Quý Thầy/Cô không thực hiện đăng nhập này</b>, có người đang dùng mã số/CCCD của Quý Thầy/Cô. ' +
         'Vui lòng bỏ qua email và báo ngay cho Phòng Tổ chức cán bộ.</p>' +
    '</div>';
  const text =
    "Ma OTP dang nhap He thong tu danh gia VC-NLD: " + code + "\n" +
    "Hieu luc " + mins + " phut. Khong cung cap ma cho bat ky ai.\n" +
    rows.map(r => r[0] + ": " + r[1]).join("\n") + "\n" +
    "Neu khong phai Quy Thay/Co dang nhap, vui long bao ngay cho Phong To chuc can bo.";

  try {
    MailApp.sendEmail({
      to: email,
      subject: "[VC-NLĐ] Mã xác thực đăng nhập",
      name: "Hệ thống đánh giá VC-NLĐ",
      htmlBody: html,
      body: text
    });
  } catch (e) {
    console.error("Lỗi gửi OTP: " + e);
    throw appError_("Không gửi được email OTP. Vui lòng thử lại sau ít phút hoặc liên hệ Phòng Tổ chức cán bộ.", "MAIL");
  }
}

function maskEmail_(email) {
  const p = str_(email).split("@");
  if (p.length !== 2) return "";
  const name = p[0];
  const shown = name.length <= 2 ? name.charAt(0) : name.slice(0, 2);
  return shown + "***" + (name.length > 4 ? name.slice(-1) : "") + "@" + p[1];
}
function isEmail_(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str_(v)); }
function nowSec_() { return Math.floor(Date.now() / 1000); }

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw appError_("Hệ thống đang bận, vui lòng thử lại", "BUSY");
  try { return fn(); } finally { lock.releaseLock(); }
}

// ============================================================
// THÔNG TIN THIẾT BỊ / MẠNG CỦA NGƯỜI ĐĂNG NHẬP
//   req.clientIp, req.client : do Cloudflare Worker gắn vào (tin cậy)
//   args.device              : do trình duyệt tự khai (chỉ dùng để ghi log)
// ============================================================
function clientCtx_(req, args) {
  const c  = (req && req.client && typeof req.client === "object") ? req.client : {};
  const d  = (args && args.device && typeof args.device === "object") ? args.device : {};
  const ua = clip_(c.userAgent || d.ua, 500);
  const p  = parseUA_(ua);

  // Client Hints (Chrome/Edge/Cốc Cốc trên Android, Windows…) cho tên máy & phiên bản thật
  const hintModel = clip_(d.model, 60);
  const hintPlat  = clip_(d.platform, 30);
  const hintVer   = clip_(d.platformVersion, 30);
  if (hintModel) p.model = hintModel;
  if (hintPlat === "Windows" && hintVer) p.osVer = Number(hintVer.split(".")[0]) >= 13 ? "11" : "10";
  else if (hintPlat === "Android" && hintVer) p.osVer = hintVer;
  else if (hintPlat === "macOS" && hintVer) p.osVer = hintVer;
  // iPad đời mới giả làm Mac → nhận biết qua màn hình cảm ứng
  if (p.os === "macOS" && Number(d.touchPoints) > 1) { p.os = "iPadOS"; p.type = "Máy tính bảng"; p.model = "iPad"; }

  const vendor = vendorOf_(p.model);
  let deviceName;
  if (p.model) deviceName = (vendor && p.model.toLowerCase().indexOf(vendor.toLowerCase()) !== 0 ? vendor + " " : "") + p.model;
  else deviceName = [p.type, p.os].filter(Boolean).join(" ");

  return {
    ip:         str_(req && req.clientIp),
    location:   [clip_(c.city, 60), clip_(c.region, 60), clip_(c.country, 10)].filter(Boolean).join(", "),
    isp:        [clip_(c.asOrganization, 80), c.asn ? "AS" + clip_(c.asn, 12) : ""].filter(Boolean).join(" · "),
    deviceName: deviceName,
    deviceType: p.type,
    os:         [p.os, p.osVer].filter(Boolean).join(" "),
    browser:    [p.browser, p.browserVer].filter(Boolean).join(" "),
    screen:     clip_(d.screen, 30),
    lang:       clip_(d.lang, 40) || clip_(String(c.acceptLanguage || "").split(",")[0], 40),
    tz:         clip_(d.tz, 50),
    ua:         ua
  };
}

function parseUA_(ua) {
  const r = { os: "", osVer: "", browser: "", browserVer: "", type: "", model: "" };
  if (!ua) return r;
  let m;
  if ((m = ua.match(/Windows NT ([\d.]+)/))) {
    r.os = "Windows"; r.type = "Máy tính";
    r.osVer = { "10.0": "10/11", "6.3": "8.1", "6.2": "8", "6.1": "7" }[m[1]] || m[1];
  } else if ((m = ua.match(/Android ([\d.]+)/))) {
    r.os = "Android"; r.osVer = m[1];
    r.type = /Mobile/.test(ua) ? "Điện thoại" : "Máy tính bảng";
    const mm = ua.match(/Android [\d.]+;(?:\s*[a-z]{2}[-_][a-z]{2};)?\s*([^;)]+)/i);
    const model = mm ? mm[1].replace(/\s*Build\/.*$/i, "").trim() : "";
    if (model && model !== "K" && !/^(wv|Linux|Mobile)$/i.test(model)) r.model = model;
  } else if ((m = ua.match(/(iPhone|iPad|iPod)[^)]*? OS ([\d_]+)/))) {
    r.os = m[1] === "iPad" ? "iPadOS" : "iOS"; r.osVer = m[2].replace(/_/g, ".");
    r.type = m[1] === "iPad" ? "Máy tính bảng" : "Điện thoại"; r.model = m[1];
  } else if ((m = ua.match(/Mac OS X ([\d_.]+)/))) {
    r.os = "macOS"; r.osVer = m[1].replace(/_/g, "."); r.type = "Máy tính";
  } else if (/CrOS/.test(ua)) { r.os = "ChromeOS"; r.type = "Máy tính"; }
  else if (/Linux/.test(ua))  { r.os = "Linux";    r.type = "Máy tính"; }

  const browsers = [
    ["Zalo",             /Zalo(?:App|Theme)?\/?([\d.]*)/],
    ["Facebook",         /FB(?:AV|_IAB)\/([\d.]+)/],
    ["Messenger",        /Messenger\/?([\d.]*)/],
    ["Cốc Cốc",          /coc_coc_browser\/([\d.]+)/],
    ["Edge",             /Edg(?:e|A|iOS)?\/([\d.]+)/],
    ["Opera",            /(?:OPR|OPT)\/([\d.]+)/],
    ["Samsung Internet", /SamsungBrowser\/([\d.]+)/],
    ["Firefox",          /(?:Firefox|FxiOS)\/([\d.]+)/],
    ["Chrome",           /(?:Chrome|CriOS)\/([\d.]+)/],
    ["Safari",           /Version\/([\d.]+).*Safari/]
  ];
  for (let i = 0; i < browsers.length; i++) {
    const b = ua.match(browsers[i][1]);
    if (b) { r.browser = browsers[i][0]; r.browserVer = (b[1] || "").split(".")[0]; break; }
  }
  return r;
}

function vendorOf_(model) {
  const s = str_(model);
  if (!s) return "";
  const rules = [
    [/^(iPhone|iPad|iPod)/i, "Apple"], [/^(SM-|Galaxy)/i, "Samsung"], [/^(CPH|OPPO|PH[A-Z]M)/i, "OPPO"],
    [/^RMX/i, "Realme"], [/^(V\d{4}|vivo)/i, "vivo"], [/^(Redmi|POCO|Mi |M\d{4}|2\d{3}[A-Z0-9]{4,})/i, "Xiaomi"],
    [/^(Pixel)/i, "Google"], [/^(Nokia|TA-)/i, "Nokia"], [/^(ASUS|ZS|AI\d)/i, "ASUS"],
    [/^(Infinix|X\d{3,4}[A-Z]?$)/i, "Infinix"], [/^(TECNO)/i, "TECNO"], [/^(moto|XT\d)/i, "Motorola"],
    [/^(HUAWEI|[A-Z]{3}-[A-Z]{1,2}\d)/i, "Huawei"], [/^(Vsmart)/i, "Vsmart"]
  ];
  for (let i = 0; i < rules.length; i++) if (rules[i][0].test(s)) return rules[i][1];
  return "";
}

function clip_(v, n) { return str_(v).replace(/[\u0000-\u001f]/g, " ").slice(0, n); }
function htmlEsc_(v) {
  return str_(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// Chặn chèn công thức vào Sheets (giá trị bắt đầu bằng = + - @)
function safeCell_(v) { const s = str_(v); return /^[=+\-@]/.test(s) ? "'" + s : s; }

// ============================================================
// GHI LOG ĐĂNG NHẬP
// ============================================================
const LOGIN_HEADERS = [
  "Thời gian", "MSNV/CCCD", "Họ tên", "Đơn vị", "Vai trò", "Trạng thái", "Chi tiết",
  "IP", "Vị trí (ước tính)", "Nhà mạng", "Tên thiết bị", "Loại thiết bị", "Hệ điều hành",
  "Trình duyệt", "Màn hình", "Ngôn ngữ", "Múi giờ", "User-Agent", "Mã phiên"
];

function logLogin_(ctx, user, status, detail, sessionId) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_LOGIN);
    if (!sheet) sheet = ss.insertSheet(SHEET_LOGIN);
    ensureLoginHeader_(sheet);

    const roleLabel = { hr: "Tổ chức cán bộ", manager: "Trưởng đơn vị", staff: "VC-NLĐ" }[user.role] || "Không xác định";
    sheet.appendRow([
      new Date(), "'" + str_(user.msnv), safeCell_(user.hoTen), safeCell_(user.donVi), roleLabel,
      status, safeCell_(detail), safeCell_(ctx.ip), safeCell_(ctx.location), safeCell_(ctx.isp),
      safeCell_(ctx.deviceName), safeCell_(ctx.deviceType), safeCell_(ctx.os), safeCell_(ctx.browser),
      safeCell_(ctx.screen), safeCell_(ctx.lang), safeCell_(ctx.tz), safeCell_(ctx.ua),
      sessionId ? String(sessionId).slice(0, 8) : ""
    ]);
  } catch (e) { console.error("Lỗi log: " + e); }
}

function ensureLoginHeader_(sheet) {
  const range = sheet.getRange(1, 1, 1, LOGIN_HEADERS.length);
  const cur = range.getValues()[0].map(str_);
  if (cur.join("|") === LOGIN_HEADERS.join("|")) return;
  range.setValues([LOGIN_HEADERS])
       .setBackground("#0f2557").setFontColor("white").setFontWeight("bold");
  sheet.setFrozenRows(1);
}

// ============================================================
// 2. KIỂM TRA TRÙNG LẶP (theo MSNV của người đang đăng nhập)
// ============================================================
function checkDoubleEntry_(args, user) {
  const month = requireMonth_(args.month);
  const sheet = getSheet_(SHEET_DANHGIA, true);
  if (!sheet) return false;
  return hasEntry_(sheet.getDataRange().getValues(), user, month);
}

// ============================================================
// 3. LƯU DỮ LIỆU TỰ ĐÁNH GIÁ
// Họ tên / đơn vị / MSNV lấy từ phiên đăng nhập, không tin dữ liệu client
// ============================================================
function saveData_(args, user) {
  const form  = args.form || {};
  const month = requireMonth_(form.assessmentMonth);

  const crit = ["diem_1_1", "diem_1_2", "diem_1_3"].map(k => {
    const v = str_(form[k]);
    return v === "" ? null : Number(v);
  });
  if (crit[0] === null) throw appError_("Vui lòng trả lời mục 1.1", "BAD_INPUT");
  const coViPham = crit.some(v => v === 0);
  if (!coViPham && crit.some(v => v !== 1)) throw appError_("Vui lòng trả lời đầy đủ mục 1", "BAD_INPUT");

  const scores = {};
  let tongDiem = 0;
  if (!coViPham) {
    SCORE_KEYS.forEach(k => {
      const raw = str_(form[k]);
      const v = Number(raw);
      if (raw === "" || SCORE_RULES[k].allowed.indexOf(v) < 0)
        throw appError_("Điểm mục " + SCORE_RULES[k].label + " không hợp lệ", "BAD_INPUT");
      scores[k] = v;
      tongDiem += v;
    });
  }
  tongDiem = Math.round(tongDiem * 10) / 10;
  const xepLoai = gradeOf_(tongDiem, coViPham);

  const extra = str_(form.extraContent).slice(0, 2000);
  if (xepLoai === "A+" && !extra)
    throw appError_("Vui lòng nhập nội dung công việc vượt định mức (bắt buộc khi A+)", "BAD_INPUT");

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw appError_("Hệ thống đang bận, vui lòng thử lại sau ít giây", "BUSY");
  try {
    const sheet = getSheet_(SHEET_DANHGIA);
    ensureMsnvHeader_(sheet);
    if (hasEntry_(sheet.getDataRange().getValues(), user, month))
      throw appError_("Bạn đã gửi đánh giá tháng " + month.replace("-", "/") + " rồi!", "DUPLICATE");

    const row = new Array(TOTAL_COLS).fill("");
    row[COL.THOIGIAN]     = new Date();
    row[COL.THANGDANHGIA] = month;
    row[COL.HOTEN]        = user.hoTen;
    row[COL.DONVI]        = user.donVi;
    crit.forEach((v, i) => { row[COL.DIEM_1_1 + i] = v === 0 ? "Vi phạm" : v === 1 ? "Không vi phạm" : ""; });
    SCORE_KEYS.forEach((k, i) => { row[COL.DIEM_2_1 + i] = coViPham ? 0 : scores[k]; });
    row[COL.TONGDIEM] = tongDiem;
    row[COL.XEPLOAI]  = xepLoai;
    row[COL.GHICHU]   = extra;
    row[COL.MSNV]     = user.msnv;

    const newRow = sheet.getLastRow() + 1;
    // Ép plain text TRƯỚC khi ghi để Sheets không tự đổi "09-2026" / MSNV thành số, ngày
    sheet.getRange(newRow, COL.THANGDANHGIA + 1).setNumberFormat("@");
    sheet.getRange(newRow, COL.MSNV + 1).setNumberFormat("@");
    sheet.getRange(newRow, 1, 1, TOTAL_COLS).setValues([row]);
    SpreadsheetApp.flush();

    return { score: tongDiem.toFixed(1), grade: xepLoai };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// 4. DỮ LIỆU ĐƠN VỊ CỦA TRƯỞNG ĐƠN VỊ (theo tháng)
// ============================================================
function getStaffData_(args, user) {
  const month = requireMonth_(args.month);
  const sheet = getSheet_(SHEET_DANHGIA, true);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (str_(r[COL.DONVI]) !== user.donVi || rowMonth_(r) !== month) continue;
    out.push(mapRow_(r, i));
  }
  return out.sort((a, b) => a.hoTen.localeCompare(b.hoTen, "vi"));
}

// ============================================================
// 5. CẬP NHẬT ĐÁNH GIÁ TRƯỞNG ĐƠN VỊ
// Mỗi dòng được kiểm tra lại (đơn vị + tháng + người) trước khi ghi;
// nếu sheet đã bị sắp xếp/xóa dòng thì tự tìm lại đúng dòng.
// ============================================================
function updateManagerEvaluations_(args, user) {
  const month = requireMonth_(args.month);
  const items = Array.isArray(args.items) ? args.items : [];
  if (!items.length) throw appError_("Không có đánh giá nào để lưu", "BAD_INPUT");
  if (items.length > 1000) throw appError_("Quá nhiều dòng trong một lần lưu", "BAD_INPUT");
  const clean = items.map(parseMgrItem_);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw appError_("Hệ thống đang bận, vui lòng thử lại sau ít giây", "BUSY");
  try {
    const sheet = getSheet_(SHEET_DANHGIA);
    const data  = sheet.getDataRange().getValues();

    const belongs = (r, it) => {
      if (!r || str_(r[COL.DONVI]) !== user.donVi || rowMonth_(r) !== month) return false;
      return it.msnv ? matchesId_(r[COL.MSNV], it.msnv) : str_(r[COL.HOTEN]) === it.hoTen;
    };

    let saved = 0;
    const missing = [];
    clean.forEach(it => {
      let idx = -1;
      const hinted = it.rowId - 1;
      if (hinted >= 1 && hinted < data.length && belongs(data[hinted], it)) {
        idx = hinted;
      } else {
        for (let i = 1; i < data.length; i++) if (belongs(data[i], it)) { idx = i; break; }
      }
      if (idx < 0) { missing.push(it.hoTen); return; }
      sheet.getRange(idx + 1, COL.SEPDIEM + 1, 1, 3).setValues([[it.sepDiem, it.sepLoai, it.sepGhiChu]]);
      saved++;
    });
    SpreadsheetApp.flush();
    return { saved: saved, missing: missing };
  } finally {
    lock.releaseLock();
  }
}

function parseMgrItem_(it) {
  it = it || {};
  const hoTen = str_(it.hoTen);
  const raw = str_(it.sepDiem).replace(",", ".");
  let sepDiem = "";
  if (raw !== "") {
    const n = Number(raw);
    if (isNaN(n) || n < 0 || n > 100) throw appError_("Điểm TĐV của " + hoTen + " phải từ 0 đến 100", "BAD_INPUT");
    sepDiem = n;
  }
  const sepLoai = str_(it.sepLoai);
  if (["", "A+", "A", "B", "C"].indexOf(sepLoai) < 0)
    throw appError_("Xếp loại TĐV của " + hoTen + " không hợp lệ", "BAD_INPUT");
  return {
    rowId: parseInt(it.rowId, 10) || 0,
    msnv: str_(it.msnv),
    hoTen: hoTen,
    sepDiem: sepDiem,
    sepLoai: sepLoai,
    sepGhiChu: str_(it.sepGhiChu).slice(0, 1000)
  };
}

// ============================================================
// 6. LỊCH SỬ CÁ NHÂN
// ============================================================
function getUserHistory_(_args, user) {
  const sheet = getSheet_(SHEET_DANHGIA, true);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (!rowOwnedBy_(r, user)) continue;
    const thang = rowMonth_(r);
    if (!thang) continue;
    out.push({
      thang: thang,
      donVi: str_(r[COL.DONVI]),
      tongDiem: cellOut_(r[COL.TONGDIEM]),
      xepLoai: str_(r[COL.XEPLOAI]),
      sepLoai: str_(r[COL.SEPLOAI])
    });
  }
  return out.sort((a, b) => monthKey_(b.thang) - monthKey_(a.thang));
}

// ============================================================
// 7. TOÀN BỘ DỮ LIỆU (HR)
// ============================================================
function getAllStaffData_(args) {
  return listAll_(requireMonth_(args.month));
}

function listAll_(month) {
  const sheet = getSheet_(SHEET_DANHGIA, true);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    if (rowMonth_(data[i]) !== month) continue;
    out.push(mapRow_(data[i], i));
  }
  return out.sort((a, b) => a.donVi.localeCompare(b.donVi, "vi") || a.hoTen.localeCompare(b.hoTen, "vi"));
}

// ============================================================
// 8. XUẤT BÁO CÁO (HR)
// ============================================================
function exportReport_(args) {
  const r = buildReportSheet_(requireMonth_(args.month));
  return { sheetName: r.sheetName, total: r.total, url: r.url };
}

function buildReportSheet_(month) {
  const data = listAll_(month);
  if (!data.length) throw appError_("Không có dữ liệu tháng " + month.replace("-", "/"), "NO_DATA");

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetName = "BaoCao_" + month;
  const old = ss.getSheetByName(sheetName);
  if (old) ss.deleteSheet(old);
  const report = ss.insertSheet(sheetName);

  const rows = data.map((it, idx) => [idx + 1, it.hoTen, it.donVi].concat(it.chiTiet, [it.sepDiem, it.sepLoai, it.sepGhiChu]));
  const w = REPORT_HEADERS.length;
  report.getRange(1, 1, 1, w).setValues([REPORT_HEADERS])
        .setBackground("#0f2557").setFontColor("white").setFontWeight("bold");
  report.getRange(2, 1, rows.length, w).setValues(rows)
        .setBackgrounds(rows.map((_, i) => new Array(w).fill(i % 2 === 0 ? "#f8fafc" : "#ffffff")));
  report.setFrozenRows(1);
  report.autoResizeColumns(1, w);
  SpreadsheetApp.flush();

  return { sheet: report, sheetName: sheetName, total: data.length, url: ss.getUrl() + "#gid=" + report.getSheetId(), data: data };
}

function exportCSVData_(args) {
  const month = requireMonth_(args.month);
  const data = listAll_(month);
  if (!data.length) throw appError_("Không có dữ liệu tháng " + month.replace("-", "/"), "NO_DATA");

  const escape = v => {
    const s = (v === null || v === undefined) ? "" : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [REPORT_HEADERS.map(escape).join(",")];
  data.forEach((it, idx) => {
    lines.push([idx + 1, it.hoTen, it.donVi].concat(it.chiTiet, [it.sepDiem, it.sepLoai, it.sepGhiChu]).map(escape).join(","));
  });

  const csv = "\uFEFF" + lines.join("\r\n");
  return {
    base64: Utilities.base64Encode(Utilities.newBlob(csv, "text/csv").getBytes()),
    fileName: "BaoCao_" + month + ".csv",
    total: data.length
  };
}

function exportExcelData_(args) {
  const month = requireMonth_(args.month);
  const r = buildReportSheet_(month);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const url = "https://docs.google.com/spreadsheets/d/" + ss.getId() + "/export?format=xlsx&gid=" + r.sheet.getSheetId();
  const response = UrlFetchApp.fetch(url, {
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200)
    throw appError_("Lỗi xuất Excel: " + response.getContentText().substring(0, 200), "EXPORT");
  return {
    base64: Utilities.base64Encode(response.getContent()),
    fileName: "BaoCao_" + month + ".xlsx",
    total: r.total
  };
}

// ============================================================
// TOKEN PHIÊN ĐĂNG NHẬP (HMAC-SHA256)
// ============================================================
function getSecret_() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty("TOKEN_SECRET");
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty("TOKEN_SECRET", s);
  }
  return s;
}

function sign_(body) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(body, getSecret_()));
}

function signToken_(user, mfa) {
  const payload = {
    msnv: user.msnv, hoTen: user.hoTen, donVi: user.donVi, role: user.role,
    mfa: mfa ? 1 : 0,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC
  };
  const body = Utilities.base64EncodeWebSafe(JSON.stringify(payload), Utilities.Charset.UTF_8);
  return body + "." + sign_(body);
}

function verifyToken_(token) {
  const invalid = () => appError_("Phiên đăng nhập không hợp lệ, vui lòng đăng nhập lại", "AUTH");
  if (!token || typeof token !== "string") throw invalid();
  const parts = token.split(".");
  if (parts.length !== 2 || sign_(parts[0]) !== parts[1]) throw invalid();
  let payload;
  try {
    payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString("UTF-8"));
  } catch (e) { throw invalid(); }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000))
    throw appError_("Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại", "AUTH");
  // Phiên Trưởng đơn vị / HR bắt buộc đã xác thực OTP (phiên cũ trước khi bật OTP bị từ chối)
  if (PRIVILEGED_ROLES.indexOf(payload.role) >= 0 && payload.mfa !== 1)
    throw appError_("Hệ thống đã bật xác thực OTP, vui lòng đăng nhập lại", "AUTH");
  return payload;
}

function checkProxyKey_(key) {
  const expected = PropertiesService.getScriptProperties().getProperty("PROXY_KEY");
  if (!expected) throw appError_("Máy chủ chưa cấu hình PROXY_KEY (Script properties)", "CONFIG");
  if (str_(key) !== expected) throw appError_("Không có quyền truy cập", "FORBIDDEN");
}

// ============================================================
// HELPERS
// ============================================================
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function appError_(message, code) {
  const e = new Error(message);
  e.isAppError = true;
  e.code = code || "";
  return e;
}

function getSheet_(name, optional) {
  const s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!s && !optional) throw appError_("Không tìm thấy sheet " + name, "CONFIG");
  return s;
}

function str_(v) { return (v === null || v === undefined) ? "" : String(v).trim(); }

function range_(from, to, step) {
  const out = [];
  for (let v = from; v <= to + 1e-9; v += step) out.push(Math.round(v * 10) / 10);
  return out;
}

// So khớp mã số, bỏ qua số 0 ở đầu (CCCD lưu dạng số trong Sheets bị mất số 0)
function normalizeId_(v) { return str_(v).toUpperCase().replace(/^0+/, ""); }
function matchesId_(a, b) {
  const x = normalizeId_(a), y = normalizeId_(b);
  return x !== "" && x === y;
}

/**
 * Chuẩn hóa mọi kiểu tháng về "MM-YYYY".
 * Chấp nhận: "09-2026", "9/2026", "09.2026", "2026-09", Date object.
 */
function normalizeMonth_(input) {
  if (input instanceof Date) return Utilities.formatDate(input, TZ, "MM-yyyy");
  const s = str_(input).replace(/\s+/g, "");
  let m, y, mt;
  if ((mt = s.match(/^(\d{1,2})[-\/.](\d{4})$/)))      { m = +mt[1]; y = +mt[2]; }
  else if ((mt = s.match(/^(\d{4})[-\/.](\d{1,2})$/))) { y = +mt[1]; m = +mt[2]; }
  else return "";
  if (m < 1 || m > 12 || y < 2000 || y > 2100) return "";
  return ("0" + m).slice(-2) + "-" + y;
}

function requireMonth_(input) {
  const month = normalizeMonth_(input);
  if (!month) throw appError_("Tháng không hợp lệ", "BAD_MONTH");
  const now = Utilities.formatDate(new Date(), TZ, "MM-yyyy");
  if (monthKey_(month) > monthKey_(now)) throw appError_("Không thể chọn tháng tương lai", "BAD_MONTH");
  return month;
}

function monthKey_(month) {
  const p = month.split("-").map(Number);
  return p[1] * 12 + p[0];
}

function rowMonth_(row) { return normalizeMonth_(row[COL.THANGDANHGIA]); }

function rowOwnedBy_(row, user) {
  const m = str_(row[COL.MSNV]);
  if (m) return matchesId_(m, user.msnv);
  return str_(row[COL.HOTEN]) === user.hoTen;   // dòng cũ chưa có MSNV
}

function hasEntry_(data, user, month) {
  for (let i = 1; i < data.length; i++)
    if (rowOwnedBy_(data[i], user) && rowMonth_(data[i]) === month) return true;
  return false;
}

function cellOut_(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return Utilities.formatDate(v, TZ, "dd/MM/yyyy");
  return v;
}

function mapRow_(row, i) {
  return {
    rowId:     i + 1,
    msnv:      str_(row[COL.MSNV]),
    hoTen:     str_(row[COL.HOTEN]),
    donVi:     str_(row[COL.DONVI]),
    chiTiet:   row.slice(COL.DIEM_1_1, COL.GHICHU + 1).map(cellOut_),
    tongDiem:  cellOut_(row[COL.TONGDIEM]),
    xepLoai:   str_(row[COL.XEPLOAI]),
    sepDiem:   cellOut_(row[COL.SEPDIEM]),
    sepLoai:   str_(row[COL.SEPLOAI]),
    sepGhiChu: str_(row[COL.SEPGHICHU])
  };
}

function gradeOf_(tong, coViPham) {
  if (coViPham) return "C";
  return tong > 90 ? "A+" : tong >= 80 ? "A" : tong >= 65 ? "B" : "C";
}

function ensureMsnvHeader_(sheet) {
  const cell = sheet.getRange(1, COL.MSNV + 1);
  if (str_(cell.getValue()) !== "MSNV") cell.setValue("MSNV").setFontWeight("bold");
}

function notify_(msg) {
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* chạy từ editor: xem ở Execution log */ }
}

function inferMonthFromTimestamp_(ts) {
  let month = Number(Utilities.formatDate(ts, TZ, "M"));
  let year  = Number(Utilities.formatDate(ts, TZ, "yyyy"));
  if (Number(Utilities.formatDate(ts, TZ, "d")) <= 15) {
    month -= 1;
    if (month === 0) { month = 12; year -= 1; }
  }
  return ("0" + month).slice(-2) + "-" + year;
}

// ============================================================
// CÔNG CỤ QUẢN TRỊ — chạy tay trong Apps Script editor (▶ Run)
// ============================================================

/**
 * CHẠY 1 LẦN sau khi cập nhật code: điền cột Y (MSNV) cho các dòng cũ
 * bằng cách đối chiếu Họ tên + Đơn vị với sheet DanhSachNhanSu.
 * Dòng nào trùng tên không xác định được sẽ được liệt kê để sửa tay.
 */
function backfillMsnv() {
  const ns = getSheet_(SHEET_NHANSU).getDataRange().getValues();
  const h  = ns[0].map(str_);
  const iM = h.indexOf("MSNV"), iH = h.indexOf("HoTen"), iD = h.indexOf("DonVi");
  if (iM < 0 || iH < 0 || iD < 0) { notify_("❌ Sheet " + SHEET_NHANSU + " thiếu cột MSNV / HoTen / DonVi"); return; }

  const byNameUnit = {}, byName = {};
  const add = (map, key, id) => { (map[key] = map[key] || {})[normalizeId_(id)] = id; };
  for (let i = 1; i < ns.length; i++) {
    const id = str_(ns[i][iM]);
    if (!id) continue;
    add(byNameUnit, str_(ns[i][iH]) + "||" + str_(ns[i][iD]), id);
    add(byName, str_(ns[i][iH]), id);
  }
  const pick = m => { if (!m) return null; const v = Object.keys(m).map(k => m[k]); return v.length === 1 ? v[0] : null; };

  const sheet = getSheet_(SHEET_DANHGIA);
  ensureMsnvHeader_(sheet);
  const data = sheet.getDataRange().getValues();
  const col = [];
  let filled = 0;
  const unresolved = [];
  for (let i = 1; i < data.length; i++) {
    const cur = str_(data[i][COL.MSNV]);
    if (cur) { col.push([cur]); continue; }
    const name = str_(data[i][COL.HOTEN]), unit = str_(data[i][COL.DONVI]);
    const id = pick(byNameUnit[name + "||" + unit]) || pick(byName[name]);
    if (id) { col.push([id]); filled++; }
    else { col.push([""]); if (name) unresolved.push("Dòng " + (i + 1) + ": " + name); }
  }
  if (col.length) {
    const rg = sheet.getRange(2, COL.MSNV + 1, col.length, 1);
    rg.setNumberFormat("@");
    rg.setValues(col);
  }
  notify_("✅ backfillMsnv xong.\n• Đã điền: " + filled + " dòng\n• Chưa xác định: " + unresolved.length +
          (unresolved.length ? "\n\n" + unresolved.slice(0, 30).join("\n") + (unresolved.length > 30 ? "\n..." : "") : ""));
}

/**
 * Sửa cột B (ThangDanhGia) bị trống / sai định dạng / bị Sheets đổi thành ngày.
 * Dòng trống sẽ suy từ timestamp cột A (ngày 1-15 → tháng trước).
 */
function fixThangDanhGia() {
  const sheet = getSheet_(SHEET_DANHGIA);
  const data = sheet.getDataRange().getValues();
  let fixed = 0, skipped = 0;

  for (let i = 1; i < data.length; i++) {
    const raw = data[i][COL.THANGDANHGIA];
    let val = null;
    if (raw instanceof Date) {
      val = normalizeMonth_(raw);
    } else if (str_(raw)) {
      if (/^(0[1-9]|1[0-2])-\d{4}$/.test(str_(raw))) continue;   // đã đúng
      val = normalizeMonth_(raw);
    } else if (data[i][COL.THOIGIAN] instanceof Date) {
      val = inferMonthFromTimestamp_(data[i][COL.THOIGIAN]);
    }
    if (!val) { skipped++; continue; }
    sheet.getRange(i + 1, COL.THANGDANHGIA + 1).setNumberFormat("@").setValue(val);
    fixed++;
  }
  notify_("✅ fixThangDanhGia xong.\n• Đã sửa: " + fixed + " dòng\n• Không xử lý được: " + skipped + " dòng");
}

/** Chỉ dùng khi sheet cũ CHƯA có cột B (ThangDanhGia). */
function migrateAddThangDanhGiaColumn() {
  const sheet = getSheet_(SHEET_DANHGIA);
  if (str_(sheet.getRange(1, 2).getValue()) === "ThangDanhGia") {
    notify_("⚠️ Cột B đã là 'ThangDanhGia'. Hãy dùng fixThangDanhGia() để sửa dữ liệu.");
    return;
  }
  sheet.insertColumnBefore(2);
  sheet.getRange(1, 2).setValue("ThangDanhGia").setFontWeight("bold");
  sheet.setColumnWidth(2, 110);

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { notify_("✅ Đã thêm cột B. Sheet trống."); return; }
  const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues()
    .map(([ts]) => [ts instanceof Date ? inferMonthFromTimestamp_(ts) : ""]);
  const rg = sheet.getRange(2, 2, values.length, 1);
  rg.setNumberFormat("@");
  rg.setValues(values);
  notify_("✅ Migration hoàn tất! Đã điền " + values.length + " dòng. Kiểm tra và chỉnh tay nếu cần.");
}

/**
 * CHẠY 1 LẦN sau khi cập nhật code: cấp quyền gửi email cho script
 * và gửi thử một email OTP mẫu tới chính tài khoản Google đang chạy script.
 */
function testOtpEmail() {
  const me = Session.getEffectiveUser().getEmail();
  sendOtpEmail_(me, { hoTen: "Quản trị hệ thống" }, "123456",
                { deviceName: "Email thử nghiệm", browser: "", ip: "", location: "" });
  notify_("✅ Đã gửi email thử tới " + me + ". Hạn mức gửi còn lại hôm nay: " + MailApp.getRemainingDailyQuota());
}

/**
 * Kiểm tra Trưởng đơn vị / HR nào chưa có email trong DanhSachNhanSu
 * (những người này sẽ KHÔNG đăng nhập được cho tới khi bổ sung email).
 */
function checkMissingEmails() {
  const data = getSheet_(SHEET_NHANSU).getDataRange().getValues();
  const h  = data[0].map(str_);
  const iM = h.indexOf("MSNV"), iH = h.indexOf("HoTen"), iD = h.indexOf("DonVi"), iR = h.indexOf("TRUONG DON VI");
  const iE = h.findIndex(x => /^(e-?mail|mail)\b/i.test(x));
  if (iE < 0) { notify_("❌ Sheet " + SHEET_NHANSU + " chưa có cột Email. Thêm một cột tiêu đề \"Email\" rồi chạy lại."); return; }
  const missing = [];
  for (let i = 1; i < data.length; i++) {
    const r = iR >= 0 ? str_(data[i][iR]).toLowerCase() : "";
    if ((r === "x" || r === "hr") && !isEmail_(data[i][iE]))
      missing.push("Dòng " + (i + 1) + ": " + str_(data[i][iH]) + " — " + str_(data[i][iD]) + " (" + str_(data[i][iM]) + ")");
  }
  notify_(missing.length ? "⚠️ " + missing.length + " người chưa có email hợp lệ:\n" + missing.join("\n")
                         : "✅ Tất cả Trưởng đơn vị / HR đều đã có email.");
}
