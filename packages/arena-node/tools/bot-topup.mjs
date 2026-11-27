// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/*
 * A TEST BOT'S TOP-UP OVER THE NEXT WORKING GATEWAY (kanban #3893). Measured 2026-11-27: the RPS opponent bot asked its top-up only through
 * GATEWAY (gw-a). LND A and LND B stopped cleanly at 06:07Z and stayed down, every top-up failed "Failed to connect to gateway" for ten hours,
 * the bot ran out at 16:32Z and every paid canary round voided for three hours - while gw-c was up the whole time.
 *
 * Now each top-up walks the bot's gateways in order (the one that worked last first) and stops at the first one whose invoice the faucet paid:
 * a gateway that cannot make an invoice (its LND down) or whose invoice the faucet could not pay is skipped, and the next one is asked.
 *
 *   gatewaysOf(env)      -> the list: GATEWAYS (comma separated) or GATEWAY, then the known testnet gateways not named yet
 *   topUp({ gateways, receive, ask, awaitReceive, log, prefer, claimMs, listed, listMs }) -> { ok, gateway, final, tried }
 *     listed() -> the federation's gateway list (kanban #3893b): only those are asked; no list -> nothing is paid
 *     receive(gw) -> { invoice, operation }   ask(invoice) -> { ok, why }   awaitReceive(operation) -> final state
 */
export const KNOWN_GATEWAYS = ['https://gw-a.bitcoin-arena.io/', 'https://gw-b.bitcoin-arena.io/', 'https://gw-c.bitcoin-arena.io/'];

const norm = (u) => String(u || '').trim().replace(/\/*$/, '/');

export function gatewaysOf(env = {}) {
  const named = String(env.GATEWAYS || env.GATEWAY || '').split(',').map((s) => s.trim()).filter(Boolean).map(norm);
  const extra = env.GATEWAYS_ONLY === '1' ? [] : KNOWN_GATEWAYS.map(norm);
  return [...new Set([...named, ...extra])];
}

/** The order to try: the gateway that worked last first, then the rest in their own order. */
export const tryOrder = (gateways, prefer) => (prefer && gateways.includes(prefer) ? [prefer, ...gateways.filter((g) => g !== prefer)] : [...gateways]);

// A CLAIM THAT NEVER COMES (measured 2026-11-27 19:50Z: the faucet paid gw-a's invoice in federation 4dc88be7 and the claim waited on for
// minutes - the wallet was held "refilling" and never asked again): after claimMs the gateway counts as failed and the next one is asked
// ONLY THE GATEWAYS JOINED TO THIS FEDERATION, AND ONLY A FEDERATION THE WALLET REACHES (kanban #3893b, measured 2026-11-27 20:00-20:20Z: gw-c
// was not joined to 4dc88be7 and the wallet reached none of its guardians, yet the faucet paid gw-a's and gw-b's invoices every pass, 6000 sat
// each into contracts nobody claimed). `listed()` is the federation's own gateway list (LockClient.gateways(), read from its guardians): a
// gateway not on it is reported "not joined" and not asked; a list that does not come within listMs, or fails, means the guardians are not
// reachable - then no invoice is made and the faucet is not asked.
export async function topUp({ gateways, receive, ask, awaitReceive, log = () => {}, prefer = null, claimMs = 180000, listed = null, listMs = 60000 }) {
  const tried = [];
  let order = tryOrder(gateways, prefer);
  if (listed) {
    let list, timer;
    try {
      list = await Promise.race([Promise.resolve().then(listed), new Promise((ok, no) => { timer = setTimeout(() => no(new Error(`no gateway list in ${Math.round(listMs / 1000)} s`)), listMs); })])
        .finally(() => clearTimeout(timer));
    } catch (e) {
      const why = `guardians not reachable: ${String(e && e.message || e)}`.slice(0, 160);
      tried.push({ gateway: '-', step: 'federation', why }); log({ step: 'top-up gateway failed', gateway: '-', stage: 'federation', why });
      return { ok: false, gateway: null, final: null, tried };
    }
    const joined = new Set((Array.isArray(list) ? list : []).map(norm));
    for (const gw of order.filter((g) => !joined.has(norm(g)))) {
      tried.push({ gateway: gw, step: 'not joined', why: 'not in the federation\'s gateway list' }); log({ step: 'top-up gateway skipped', gateway: gw, stage: 'not joined', why: 'not in the federation\'s gateway list' });
    }
    order = order.filter((g) => joined.has(norm(g)));
  }
  for (const gw of order) {
    let rcv;
    try { rcv = await receive(gw); } catch (e) { tried.push({ gateway: gw, step: 'invoice', why: String(e && e.message || e).slice(0, 160) }); log({ step: 'top-up gateway failed', gateway: gw, stage: 'invoice', why: tried[tried.length - 1].why }); continue; }
    let r;
    try { r = await ask(rcv.invoice); } catch (e) { r = { ok: false, why: String(e && e.message || e).slice(0, 160) }; }
    if (!r || !r.ok) { tried.push({ gateway: gw, step: 'faucet', why: String((r && r.why) || 'no answer').slice(0, 160) }); log({ step: 'top-up gateway failed', gateway: gw, stage: 'faucet', why: tried[tried.length - 1].why }); continue; }
    let timer;
    const final = await Promise.race([awaitReceive(rcv.operation).catch((e) => ({ failed: String(e && e.message || e).slice(0, 160) })),
      new Promise((ok) => { timer = setTimeout(() => ok({ failed: `no claim in ${Math.round(claimMs / 1000)} s` }), claimMs); })]).finally(() => clearTimeout(timer));
    if (final && typeof final === 'object' && final.failed) { tried.push({ gateway: gw, step: 'claim', why: final.failed }); log({ step: 'top-up gateway failed', gateway: gw, stage: 'claim', why: final.failed }); continue; }
    return { ok: true, gateway: gw, final, tried };
  }
  return { ok: false, gateway: null, final: null, tried };
}
