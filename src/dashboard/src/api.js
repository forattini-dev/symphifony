import { safeJson } from "./utils.js";

function extractError(data, status) {
  if (!data) return `HTTP ${status}`;
  const err = data.error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") return err.message || err.code || JSON.stringify(err);
  return data.message || `HTTP ${status}`;
}

export const api = {
  /** GET request that parses JSON. Throws on non-2xx with server error message. */
  async get(path) {
    const res = await fetch(`/api${path}`, {
      headers: { Accept: "application/json" },
    });
    const text = await res.text();
    const data = text ? safeJson(text) : null;
    if (!res.ok) throw new Error(extractError(data, res.status));
    return data || { ok: true };
  },

  /** POST request with JSON body. Throws on non-2xx with server error message. */
  async post(path, payload) {
    const res = await fetch(`/api${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    const data = text ? safeJson(text) : null;
    if (!res.ok) throw new Error(extractError(data, res.status));
    return data || { ok: true };
  },
};
