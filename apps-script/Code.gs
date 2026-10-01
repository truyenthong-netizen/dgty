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
// ============================================================
function login_(args, _user, req) {
  const msnv = str_(args.msnv);
  const ip   = str_(req.clientIp);
  if (!msnv) throw appError_("Vui lòng nhập mã số", "BAD_INPUT");
  checkRateLimit_(ip);

  const matches = findStaff_(msnv);
  if (!matches.length) {
    registerFail_(ip);
    logLogin(msnv, "(Không tìm thấy)", "(Không tìm thấy)", "Không xác định", "❌ Sai mã số");
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
  const roleLabel = { hr: "Tổ chức cán bộ", manager: "Trưởng đơn vị", staff: "VC-NLĐ" }[user.role];
  logLogin(msnv, user.hoTen, user.donVi, roleLabel, "✅ Thành công");
  return { multiUnit: false, token: signToken_(user), user: user };
}

function findStaff_(msnv) {
  const data = getSheet_(SHEET_NHANSU).getDataRange().getValues();
  const h  = data[0].map(str_);
  const iM = h.indexOf("MSNV"), iH = h.indexOf("HoTen"), iD = h.indexOf("DonVi"), iR = h.indexOf("TRUONG DON VI");
  if (iM < 0 || iH < 0 || iD < 0)
    throw appError_("Sheet " + SHEET_NHANSU + " thiếu cột MSNV / HoTen / DonVi", "CONFIG");

  const out = [];
  for (let i = 1; i < data.length; i++) {
    if (!matchesId_(data[i][iM], msnv)) continue;
    const r = iR >= 0 ? str_(data[i][iR]).toLowerCase() : "";
    out.push({
      msnv:  str_(data[i][iM]),
      hoTen: str_(data[i][iH]),
      donVi: str_(data[i][iD]),
      role:  r === "hr" ? "hr" : r === "x" ? "manager" : "staff"
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
// GHI LOG ĐĂNG NHẬP
// ============================================================
function logLogin(msnv, hoTen, donVi, role, status) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_LOGIN);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_LOGIN);
      const h = ["Thời gian", "MSNV/CCCD", "Họ tên", "Đơn vị", "Vai trò", "Trạng thái"];
      sheet.appendRow(h);
      sheet.getRange(1, 1, 1, h.length).setBackground("#0f2557").setFontColor("white").setFontWeight("bold");
      sheet.setFrozenRows(1);
      sheet.setColumnWidths(1, h.length, 150);
    }
    sheet.appendRow([new Date(), "'" + msnv, hoTen, donVi, role, status]);
  } catch (e) { console.error("Lỗi log: " + e); }
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

function signToken_(user) {
  const payload = {
    msnv: user.msnv, hoTen: user.hoTen, donVi: user.donVi, role: user.role,
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
