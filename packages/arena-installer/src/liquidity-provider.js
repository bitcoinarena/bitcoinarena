// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LIQUIDITY PROVIDER SERVICE (spec §23A.102026-10-18: "This service alone listens to new nodes and creates
// incoming liquidity for them ... at least one connection to each node, maximum 2 ... needs to communicate with other nodes who opens
// liquidity to a new node"). Every tick:
//   1. its own LND: the channels it gave (open and pending - a pending open already counts, so no other provider doubles it) and its
//      free balance;
//   2. its liquidity claim, signed by its node key, written where its seat (or its own small server) serves it;
//   3. the others: every provider's claim and every node's gateway claim (GET /liquidity-claim and /gateway-claim at each endpoint);
//   4. the assignment (liquidity.js), the same as every other provider computes; where this provider is named, it dials the node and
//      opens one channel of L. A provider the assignment named that has not opened an hour later is skipped for that node.
// It opens nothing below L, and nothing when its free balance is under L - its claim then says so, and the top-up address is LND's.
import { signLiquidityClaim, checkLiquidityClaim, assignLiquidity, fundsMessage, LIQUIDITY_TERMS, MAX_FUNDS } from '../../arena-protocol/src/liquidity.js';
import { checkGatewayClaim } from '../../arena-protocol/src/gateway-claim.js';

export const SKIP_AFTER_MS = 3600000;

/**
 * `node` this provider's node key (hex) and `sign(hash) -> sig`; `lnd` { channels(), funds(), connect({ pubkey, host }), openTo({ pubkey,
 * sats }), info(), coins() and signWithAddr({ address, message }) - the last two optional: without them the claim proves no coin }; `endpoints()` the network's seat addresses; `writeClaim(claim)`; `state` (kept between ticks: rankedAt, opened).
 * Answers per tick { ok, claim, opened: [node], why }.
 */
export function createLiquidityProvider({ node, sign, verify, lnd, endpoints, writeClaim, network = 'testnet4', state = {}, fetcher = fetch, nowMs = () => Date.now(), log = () => {} }) {
  const L = LIQUIDITY_TERMS[network].channelSats;
  const getJson = async (u) => { try { const r = await fetcher(u, { signal: AbortSignal.timeout(10000) }); return r.status === 200 ? await r.json() : null; } catch { return null; } };
  async function tick() {
    const [ch, f, info] = await Promise.all([lnd.channels(), lnd.funds(), lnd.info()]);
    if (!ch.ok || !f.ok || !info.ok) return { ok: false, why: `LND did not answer: ${(!ch.ok && ch.why) || (!f.ok && f.why) || info.why}` };
    const given = [...ch.open.filter((x) => x.initiator), ...ch.pending.filter((x) => x.initiator)].map((x) => ({ peer: x.peer, capacitySats: x.capacitySats }));
    const lightningAddr = ((info.uris || []).map((u) => String(u).split('@')[1]).find(Boolean)) || '';
    if (!state.depositAddress && f.address) state.depositAddress = f.address;   // one top-up address, kept (LND makes a new one per ask)
    // THE PROOF OF THE FREE BALANCE (§23A.10): every confirmed coin, largest first, signed by its address key for this node - a
    // coin's signature is kept, so each is signed once
    const funds = [];
    const coins = lnd.coins ? await lnd.coins() : { ok: false };
    if (coins.ok) {
      state.fundSigs = state.fundSigs || {};
      for (const k of [...coins.coins].sort((a, b) => b.sats - a.sats).slice(0, MAX_FUNDS)) {
        const id = `${k.txid}:${k.vout}`;
        if (!state.fundSigs[id]) { const s = await lnd.signWithAddr({ address: k.address, message: fundsMessage(node, k.txid, k.vout) }); if (s.ok) state.fundSigs[id] = s.signature; }
        if (state.fundSigs[id]) funds.push({ txid: k.txid, vout: k.vout, address: k.address, sats: k.sats, signature: state.fundSigs[id] });
      }
      const live = new Set(coins.coins.map((k) => `${k.txid}:${k.vout}`));
      for (const id of Object.keys(state.fundSigs)) if (!live.has(id)) delete state.fundSigs[id];
    }
    const claim = signLiquidityClaim({ node, lightningPubkey: info.pubkey, lightningAddr, freeSats: f.onchainSats, atMs: nowMs(), channels: given, depositAddress: state.depositAddress || '', funds }, sign);
    await writeClaim(claim);
    // the others, as every provider reads them
    const eps = (await endpoints()) || [];
    const claims = [claim], needs = [];
    for (const e of eps) {
      const base = String(e).replace(/\/+$/, '');
      const [lc, gc] = await Promise.all([getJson(`${base}/liquidity-claim`), getJson(`${base}/gateway-claim`)]);
      // one claim per provider, the newest: a provider is reached at its seat and as a peer, and counted twice it could be drawn twice
      if (lc && lc.node !== node && checkLiquidityClaim(lc, verify).ok) {
        const i = claims.findIndex((c) => c.node === lc.node);
        if (i < 0) claims.push(lc); else if (BigInt(lc.atMs) > BigInt(claims[i].atMs)) claims[i] = lc;
      }
      if (gc && checkGatewayClaim(gc, verify).ok) needs.push({ node: gc.node, lightningPubkey: gc.lightningPubkey, lightningAddr: gc.lightningAddr || '' });
    }
    // skipped: a provider the assignment named for a node that still shows no channel to it an hour later
    state.rankedAt = state.rankedAt || {};
    const skipped = new Set(Object.entries(state.rankedAt).filter(([, at]) => nowMs() - at > SKIP_AFTER_MS).map(([k]) => k));
    const plan = assignLiquidity({ needs, claims, network, skipped });
    for (const p of plan) for (const prov of p.open) { const k = `${p.node}:${prov}`; if (!state.rankedAt[k]) state.rankedAt[k] = nowMs(); }
    const opened = [];
    for (const p of plan.filter((x) => x.open.includes(node))) {
      if (BigInt(f.onchainSats) - BigInt(opened.length) * L < L + 1000n) { log(`named for ${p.node.slice(0, 12)}… but holds ${f.onchainSats} sat: top up`); break; }
      const target = needs.find((n) => n.node === p.node);
      if (target && target.lightningAddr) await lnd.connect({ pubkey: p.lightningPubkey, host: target.lightningAddr });
      const o = await lnd.openTo({ pubkey: p.lightningPubkey, sats: L });
      if (!o.ok) { log(`channel to ${p.node.slice(0, 12)}… not opened: ${o.why}`); continue; }
      opened.push(p.node);
      log(`liquidity for ${p.node.slice(0, 12)}…: ${L} sat channel, ${o.fundingTxid}`);
    }
    return { ok: true, claim, opened, why: `${claims.length} provider(s), ${needs.length} node(s) with a gateway, ${plan.length} wanting liquidity, ${opened.length} opened by this one` };
  }
  // ONE TICK AT A TIME: the minute's tick and an owner's new address never run side by side (two would open two channels)
  let queue = Promise.resolve();
  const serial = (fn) => (queue = queue.then(fn, fn));
  /**
   * A NEW TOP-UP ADDRESS (2026-10-18: "a button generate a new address for the lp wallet"): LND makes one, it becomes the
   * claim's depositAddress at once (the claim re-signed and written), and the owner page and dashboard show it. Answers { ok, address }.
   */
  const newAddress = () => serial(async () => {
    const f = await lnd.funds();
    if (!f.ok || !f.address) return { ok: false, why: `LND made no address: ${f.why || 'none given'}` };
    state.depositAddress = f.address;
    const t = await tick();
    return t.ok ? { ok: true, address: f.address } : { ok: false, why: t.why };
  });
  return { tick: () => serial(tick), newAddress };
}
