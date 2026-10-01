/**
 * Kiểm tra "vé" xác thực Google do Apps Script XacThuc.gs cấp.
 * Vé dạng  <payload base64url>.<HMAC-SHA256 base64url>  với payload {email, iat, exp, n}.
 */

export class TicketError extends Error {}

const CLOCK_SKEW = 60;

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** @returns {Promise<{email:string}>} */
export async function verifyTicket(ticket, secret) {
  const fail = (m) => { throw new TicketError(m || "Xác thực Google không hợp lệ, vui lòng xác thực lại"); };
  if (typeof ticket !== "string" || ticket.length > 2048) fail();
  const parts = ticket.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) fail();

  let sig;
  try { sig = b64urlToBytes(parts[1]); } catch { fail(); }

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
  );
  const ok = await crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(parts[0]));
  if (!ok) fail();

  let p;
  try { p = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0]))); } catch { fail(); }

  const now = Math.floor(Date.now() / 1000);
  if (typeof p.exp !== "number" || p.exp + CLOCK_SKEW < now) fail("Phiên xác thực Google đã hết hạn, vui lòng xác thực lại");
  if (typeof p.iat === "number" && p.iat - CLOCK_SKEW > now) fail();
  const email = String(p.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail();
  return { email };
}
