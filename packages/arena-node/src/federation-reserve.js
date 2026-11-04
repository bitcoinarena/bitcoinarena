// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FEDERATION'S ON-CHAIN RESERVE (spec §23A.3,: "Custody held is public. A federation's reserve is its on-chain
// wallet"; load = reserve / exposure_cap). Read from its guardians' stock wallet module: each guardian's public
// `wallet_summary` over its JSON-RPC WebSocket (the API the stock client uses), and kept only when at least `threshold`
// guardians answer the same sum - one guardian cannot move the number. The reserve is the federation's own coins: the
// spendable UTXOs and its change not yet confirmed or signed; peg-outs on their way out are not.
import { parseRoutes, routed } from './fetch-routes.js';

const sumOf = (list) => (list || []).reduce((t, u) => t + BigInt(u.amount || 0), 0n);
export const reserveOfSummary = (s) => sumOf(s.spendable_utxos) + sumOf(s.unconfirmed_change_utxos) + sumOf(s.unsigned_change_utxos);

// AND A walletv2 FEDERATION (the fork's regtest federations; measured on the test host's two-federation regtest 2026-10-12,
//: "0 of 7 guardians named one reserve"): its wallet module keeps the federation's coins in one output and
// answers `federation_wallet` - { value, outpoint, tweak }, or null before the first peg-in. Its value is the reserve.
const V2 = 100;   // a federation_wallet request's JSON-RPC id is V2 + the module id, beside wallet_summary's module id

/** One guardian's reserve: the wallet module found by trying the module ids (the first to answer either method). */
// THE SAME ROUTES THE FEDERATION CLIENT TAKES (measured 2026-10-13 ~20:10Z: federation B's seats run on the test host, and
// their guardians' advertised endpoints go out to the the test host's Funnel and back over a ship's Starlink link - every reserve read
// timed out, "0 of 7 guardians named one reserve", and federation B had no record): FM_WS_API_CONNECT_OVERRIDES, the Fedimint
// client's own "<advertised>=<reach>" list, rewrites an endpoint before it is opened; with none set nothing changes
const OVERRIDES = new Map(String(process.env.FM_WS_API_CONNECT_OVERRIDES || '').split(',').filter((x) => x.includes('=')).map((x) => {
  const i = x.indexOf('='); return [x.slice(0, i).replace(/\/+$/, ''), x.slice(i + 1).replace(/\/+$/, '')];
}));
// AND THE SEAT'S OWN ROUTES (kanban #549, measured 2026-10-20 ~07:20Z: federation B drained into 4dc88be7, whose guardians are B's
// seats' guardian-next at wss://seat.example.com/fed2-N/guardian-next; the overrides named /fed2-N and /fed2-N/guardian only,
// so every read went out to the Funnel the test host cannot reach - "0 of 7 guardians named one reserve", no record, no successor
// listed): an endpoint no override names is routed by ARENA_ROUTE_MAP (fetch-routes.js), its scheme carried over (wss <-> https,
// ws <-> http) - every path under a seat's public prefix, a successor's guardian-next too, with nothing added by hand
const ROUTES = parseRoutes(process.env.ARENA_ROUTE_MAP);
export function routedEndpoint(endpoint, { overrides = OVERRIDES, routes = ROUTES } = {}) {
  const e = String(endpoint).replace(/\/+$/, '');
  if (overrides.has(e)) return overrides.get(e);
  const m = /^(wss?):\/\//.exec(e);
  if (!m || !routes.length) return endpoint;
  const asHttp = (m[1] === 'wss' ? 'https://' : 'http://') + e.slice(m[0].length);
  const to = routed(asHttp, routes);
  return to === asHttp ? endpoint : to.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
}

async function askOne(endpoint, { timeoutMs, moduleId, WS }) {
  endpoint = routedEndpoint(endpoint);
  return new Promise((done) => {
    let ws; const finish = (v) => { try { ws && ws.close(); } catch { /* closed */ } done(v); };
    const timer = setTimeout(() => finish({ ok: false, why: 'no answer in time' }), timeoutMs);
    try { ws = new WS(endpoint); } catch (e) { clearTimeout(timer); done({ ok: false, why: e.message }); return; }
    const ids = moduleId !== null && moduleId !== undefined ? [moduleId] : [0, 1, 2, 3, 4, 5, 6, 7];
    let left = ids.length * 2;
    const ask = (id, method) => ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: [{ auth: null, params: null }] }));
    ws.addEventListener('open', () => { for (const id of ids) { ask(id, `module_${id}_wallet_summary`); ask(V2 + id, `module_${id}_federation_wallet`); } });
    ws.addEventListener('message', (e) => {
      let j; try { j = JSON.parse(String(e.data)); } catch { return; }
      if (j.result && Array.isArray(j.result.spendable_utxos)) { clearTimeout(timer); finish({ ok: true, moduleId: j.id, reserveSats: reserveOfSummary(j.result) }); return; }
      if (j.id >= V2 && !j.error && 'result' in j && (j.result === null || (j.result && j.result.value !== undefined))) {
        clearTimeout(timer); finish({ ok: true, moduleId: j.id - V2, walletV2: true, reserveSats: j.result === null ? 0n : BigInt(j.result.value), outpoint: j.result && j.result.outpoint ? String(j.result.outpoint) : null }); return;
      }
      if (--left <= 0) { clearTimeout(timer); finish({ ok: false, why: 'no wallet module answered wallet_summary or federation_wallet' }); }
    });
    ws.addEventListener('error', () => { clearTimeout(timer); finish({ ok: false, why: 'the connection failed' }); });
  });
}

/**
 * THE RESERVE, BY A THRESHOLD OF GUARDIANS: every endpoint asked at once; the sum at least `threshold` of them name, or a
 * refusal naming what they said. `{ ok, reserveSats, agreeing, of, moduleId }`.
 */
// AND IT ANSWERS AS SOON AS A THRESHOLD AGREES (kanban #549, measured 2026-10-20 ~07:22Z: federation 4dc88be7 has 7 guardians and one
// unreachable, so every read waited out its 8 s timeout; a guardian seat asked to sign reads the reserve first, so it answered the
// gatherer in 8.07 s - past the gatherer's own 8 s - and the successor's record never got more than 1 of the 5 signatures it needs)
// guardians agree on the sum and, for walletv2, on the output that holds it
const keyOf = (s) => `${s.reserveSats}|${s.outpoint || ''}`;
export async function readReserve({ endpoints, threshold, timeoutMs = 8000, moduleId = null, WS = globalThis.WebSocket }) {
  const said = await new Promise((done) => {
    const got = new Array(endpoints.length).fill(null), counts = new Map();
    let left = endpoints.length;
    if (!left) { done(got); return; }
    endpoints.forEach((e, i) => askOne(e, { timeoutMs, moduleId, WS }).then((s) => {
      got[i] = s; left--;
      if (s.ok) { const k = keyOf(s); counts.set(k, (counts.get(k) || 0) + 1); if (counts.get(k) >= threshold) { done(got.filter(Boolean)); return; } }
      if (!left) done(got);
    }));
  });
  const counts = new Map();
  for (const s of said) if (s.ok) counts.set(keyOf(s), (counts.get(keyOf(s)) || 0) + 1);
  const [best, n] = [...counts].sort((a, b) => b[1] - a[1])[0] || [null, 0];
  if (best === null || n < threshold)
    return { ok: false, why: `${n} of ${endpoints.length} guardians named one reserve, and ${threshold} must`, of: endpoints.length, agreeing: n };
  const [sats, outpoint] = best.split('|');
  // a walletv2 federation's one output, named by the same threshold (kanban #1108: what the spend watch follows); null for the stock wallet
  return { ok: true, reserveSats: BigInt(sats), agreeing: n, of: endpoints.length, moduleId: (said.find((s) => s.ok) || {}).moduleId ?? null, outpoint: outpoint || null };
}
