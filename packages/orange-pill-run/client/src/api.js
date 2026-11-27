// Orange Pill Run - the round service's client (kanban #3251, #3265). No DOM: the page bridge and fetch are handed in, so node tests run it
// with fakes. Sign-in is the service's NIP-98 (kind 27235): the tag `u` names signBase + path (https://testnet-stage.bitcoinarena.io/api/opr<path>),
// `method`, and on a POST `payload` = sha256 hex of the exact body string sent.
//   makeApi({ base, signBase, bridge, fetch, sha256Hex }) -> { get(path), getSigned(path), post(path, body) }
//   bridge.signHttpAuth(tags) -> the signed event (the page's identity key), or throws when the tab has no wallet yet
export const HTTP_AUTH_KIND = 27235;

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

const nonce = () => { const b = new Uint8Array(12); try { crypto.getRandomValues(b); } catch (_) { for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256); }
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""); };
const b64 = (s) => (typeof btoa === "function" ? btoa(unescape(encodeURIComponent(s))) : Buffer.from(s, "utf8").toString("base64"));

export function makeApi({ base, signBase = base, bridge = null, fetch: f = (...a) => fetch(...a), sha = sha256Hex, timeoutMs = 15000 } = {}) {
  const clean = (u) => String(u).replace(/\/+$/, "");
  const B = clean(base), S = clean(signBase);
  async function authHeader(path, method, body) {
    if (!bridge || typeof bridge.signHttpAuth !== "function") throw new Error("no wallet to sign in with");
    const tags = [["u", S + String(path).split("?")[0]], ["method", method]];   // the service names the path without its query
    if (method === "POST") tags.push(["payload", await sha(body)]);
    // #3251: a nonce makes every sign-in its own event. Without it two GET /me in the same second were the same event (same tags, same
    // created_at), and the service, which takes each sign-in once, refused the second: "that sign-in was used already" - the counters stayed old
    tags.push(["nonce", nonce()]);
    const e = await bridge.signHttpAuth(tags);
    return "Nostr " + b64(JSON.stringify(e));
  }
  async function call(path, { method = "GET", body = null, signed = false } = {}) {
    const text = body == null ? "" : JSON.stringify(body);
    const headers = {};
    if (method === "POST") headers["content-type"] = "application/json";
    if (signed) headers.authorization = await authHeader(path, method, text);
    let r;
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try { r = await f(B + path, { method, headers, body: method === "POST" ? text : undefined, cache: "no-store", signal: ctl ? ctl.signal : undefined }); }
    catch (e) { return { ok: false, status: 0, why: "the round service did not answer" }; }
    finally { if (t) clearTimeout(t); }
    let j = null;
    try { j = await r.json(); } catch { j = null; }
    if (!j || typeof j !== "object") return { ok: false, status: r.status, why: `the round service answered ${r.status}` };
    return { ...j, status: r.status };
  }
  return {
    get: (path) => call(path),
    getSigned: (path) => call(path, { signed: true }),
    post: (path, body) => call(path, { method: "POST", body: body || {}, signed: true }),
  };
}
