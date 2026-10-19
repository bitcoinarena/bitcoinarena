// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PERMANENT NAME ON THE OPERATOR'S OWN workers.dev (2026-10-18: "Implement workers dev tunnel"). For a node that
// cannot open a port and has no domain: its quick Cloudflare tunnel (a random name, new at every restart) sits behind a Worker on the
// operator's own free Cloudflare account, https://arena-node-<id>.<their subdomain>.workers.dev - a name that never changes. The
// Worker forwards every request (websockets too) to the tunnel; when the tunnel's name changes, the node uploads the Worker again with
// the new one (the workers keeper, bin/workers-keeper.mjs), which takes effect at once. The traffic and the account are the operator's
// (the owner: we do not carry nodes' traffic). The installer acts with an API token the operator makes from Cloudflare's
// "Edit Cloudflare Workers" template; it is kept 0600 in the node's home.
const API = 'https://api.cloudflare.com/client/v4';
export const TOKEN_PAGE = 'https://dash.cloudflare.com/profile/api-tokens';
export const COMPATIBILITY_DATE = '2025-09-01';

/** The Worker's name: arena-node-<6 hex>, chosen once per node (the node key does not exist yet when the reach is chosen). */
export const workerNameOf = (suffix) => `arena-node-${String(suffix).toLowerCase()}`;

async function cf(token, path, { method = 'GET', body = null, headers = {}, fetcher = fetch } = {}) {
  let r;
  try { r = await fetcher(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...headers }, body, signal: AbortSignal.timeout(30000) }); }
  catch (e) { return { ok: false, why: `Cloudflare's API did not answer: ${e.message}` }; }
  let j = null;
  try { j = await r.json(); } catch { j = null; }
  if (j && j.success) return { ok: true, result: j.result };
  const err = j && j.errors && j.errors[0];
  return { ok: false, status: r.status, code: err && err.code, why: err ? `${err.message} (Cloudflare ${err.code})` : `Cloudflare answered ${r.status}` };
}

/** The Worker: every request to the tunnel `target`, as it came; a redirect to the tunnel's own name turned back into the Worker's. */
export function forwarderScript(target) {
  if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(target)) throw new Error('the Worker forwards only to a quick tunnel');
  return `// The Arena node's permanent address, written by the node: it forwards to its quick tunnel, which it updates here.
const TARGET = ${JSON.stringify(target)};
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const res = await fetch(new Request(TARGET + url.pathname + url.search, request), { redirect: 'manual' });
    if (res.status === 101) return res;
    const loc = res.headers.get('location');
    if (loc && loc.startsWith(TARGET)) { const out = new Response(res.body, res); out.headers.set('location', url.origin + loc.slice(TARGET.length)); return out; }
    return res;
  },
};
`;
}

/**
 * Step 1, when the operator pastes the token: its account, and the account's workers.dev subdomain (made from `wantSubdomain` when
 * the account has none). Answers { ok, accountId, subdomain, url, why }.
 */
export async function workersSetup({ token, name, wantSubdomain = null, fetcher = fetch }) {
  if (!/^[A-Za-z0-9_-]{30,}$/.test(String(token || ''))) return { ok: false, why: 'paste the API token (made from the "Edit Cloudflare Workers" template)' };
  const acc = await cf(token, '/accounts', { fetcher });
  if (!acc.ok) return { ok: false, why: `the token is not accepted: ${acc.why}` };
  if (!acc.result.length) return { ok: false, why: 'the token reaches no account: make it from the "Edit Cloudflare Workers" template with your account included' };
  const accountId = acc.result[0].id;
  let sub = await cf(token, `/accounts/${accountId}/workers/subdomain`, { fetcher });
  if (!sub.ok || !sub.result || !sub.result.subdomain) {
    const want = String(wantSubdomain || `arena-${Math.random().toString(36).slice(2, 8)}`).toLowerCase();
    sub = await cf(token, `/accounts/${accountId}/workers/subdomain`, { method: 'PUT', body: JSON.stringify({ subdomain: want }), headers: { 'content-type': 'application/json' }, fetcher });
    if (!sub.ok) return { ok: false, why: `the account has no workers.dev name yet and none could be made: ${sub.why}` };
  }
  const subdomain = sub.result.subdomain;
  return { ok: true, accountId, subdomain, url: `https://${name}.${subdomain}.workers.dev` };
}

/** Step 2, at the install and at every new tunnel name: the Worker uploaded with `target`, and served on workers.dev. */
export async function deployForwarder({ token, accountId, name, target, fetcher = fetch }) {
  let script;
  try { script = forwarderScript(target); } catch (e) { return { ok: false, why: e.message }; }
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({ main_module: 'worker.js', compatibility_date: COMPATIBILITY_DATE })], { type: 'application/json' }));
  form.append('worker.js', new Blob([script], { type: 'application/javascript+module' }), 'worker.js');
  const up = await cf(token, `/accounts/${accountId}/workers/scripts/${name}`, { method: 'PUT', body: form, fetcher });
  if (!up.ok) return { ok: false, why: `the Worker could not be uploaded: ${up.why}` };
  const on = await cf(token, `/accounts/${accountId}/workers/scripts/${name}/subdomain`, { method: 'POST', body: JSON.stringify({ enabled: true }), headers: { 'content-type': 'application/json' }, fetcher });
  if (!on.ok) return { ok: false, why: `the Worker is uploaded but not served on workers.dev: ${on.why}` };
  return { ok: true, target };
}

/**
 * THE KEEPER (bin/workers-keeper.mjs, a service of the node): reads the quick tunnel's current name (`tunnelUrl()`), and when it is not
 * the one the Worker forwards to, uploads the Worker with it. Answers per tick { ok, did?, idle?, why? }.
 */
export function createWorkersKeeper({ state, tunnelUrl, deploy = deployForwarder, log = () => {} }) {
  async function tick() {
    const s = state.read();
    const r = s.reach || {};
    if (r.mode !== 'workers') return { ok: true, idle: 'this node is not reached through workers.dev' };
    const token = state.readSecret('cf-workers-token');
    if (!token) return { ok: false, why: 'no Cloudflare token kept (cf-workers-token): set the reach up again in the installer' };
    const now = await tunnelUrl();
    if (!now) return { ok: false, why: 'the quick tunnel has no name yet' };
    if (now === r.target) return { ok: true, idle: `forwarding to ${now}` };
    const d = await deploy({ token, accountId: r.accountId, name: r.workerName, target: now });
    if (!d.ok) return d;
    state.save({ reach: { ...state.read().reach, target: now, targetAtMs: Date.now() } });
    log(`${r.url} now forwards to ${now}`);
    return { ok: true, did: 'forward', target: now };
  }
  return { tick };
}
