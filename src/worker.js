/**
 * Cloudflare Worker — điểm vào của ứng dụng.
 *   /api      → chuyển tiếp tới Google Apps Script (src/api.js)
 *   còn lại   → trả file tĩnh trong thư mục public/
 */
import { handleApi } from "./api.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api") return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
};
