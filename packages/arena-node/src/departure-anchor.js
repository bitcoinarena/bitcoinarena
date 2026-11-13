// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A LEAVING NODE POSTS ITS OWN DEPARTURE ANCHOR (kanban #2610, the posting side of #2608 / ruling #2600): from DEPARTURE_ANCHOR_HEIGHT on
// a notice counts only from the confirmed height of an OP_RETURN "ARN" 'L' || departure_id (absence.js), and the notice travels with that
// transaction's txid and block hash. #2608 built the reading side; nothing posted the anchor, so past the gate a node's own notice would
// never count. Here the node funds that transaction from its wallet, waits until it is confirmed on its own chain, reads it there as every
// seat will (absences.js readAnchor), and only then publishes the notice with its anchor.
// THE ANCHOR CARRIES THE WHOLE NOTICE (kanban #2612, feedback #041): OP_RETURN "ARN" 'L' || notice || signature (176 bytes, absence.js), so
// sending it IS publishing it - every seat reads it off its chain at the anchor's block (absences.js scanDepartures); the POST that
// follows only makes it known sooner.
//
//   (none) --build, written--> BUILT --sent--> SENT --confirmed `depth` deep, read on this chain--> CONFIRMED --posted--> PUBLISHED
//
//   - ONE ANCHOR PER NOTICE, EVER: the record is keyed by departure_id and written (with the signed bytes) BEFORE the first broadcast; a
//     restart, a second Leave, the owner's command or the minute's pass find it and send THE SAME BYTES again, never fund a second one;
//   - a notice is published with its anchor only once that anchor is confirmed and reads on this node's chain;
//   - a reorg that takes the anchor's block away sends the record back to SENT (the same transaction is looked for again, and the
//     notice published again with its new block).
//
// `wallet` { name, build(d) -> { ok, hex, txid, feeSats, sent? } | { ok: false, why }, send(hex), where?(txid) -> { blockHash, height } | null }
// `chain`  { tip(), blockAt(h) -> { hash, txids } }: this node's own bitcoind, to find the anchor when the wallet cannot say (and to judge depth)
// `confirmedTx(txid, blockHash)` the seats' reader (main.js ballot.confirmedTx); `publish(d)` keeps and posts the anchored notice
// `store` { read() -> object | null, write(object) }
import { departureId, departureAnchorScript, encodeDepartureAnchor } from '../../arena-protocol/src/absence.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { departureHex, readDepartureHex, readAnchor } from './absences.js';

export const ANCHOR_FEE_RATE = 2;           // sat/vB, as the bond wallet's other posts (add-bond-wallet.js)
export const PHASE = Object.freeze({ BUILT: 'built', SENT: 'sent', CONFIRMED: 'confirmed', PUBLISHED: 'published' });
const P = PHASE;
const SCAN_MAX = 144;                       // blocks looked through per pass for an anchor the wallet cannot place
const RESCAN = 6;                           // the newest blocks looked at again each pass (a reorg near the tip)
const REORG_WATCH = 144;                    // a published anchor's block is checked while it is less deep than this
// "already there" from a broadcast is a success: the bytes are in the mempool or a block
export const ALREADY = /already in (the )?(block ?chain|mempool|utxo set)|txn-already-(known|in-mempool)|already have transaction|outputs already in utxo set|transaction already exists|-27\b/i;

const strip = (d) => { const { anchor, ...rest } = d; void anchor; return rest; };
export const anchorIdOf = (d) => toHex(departureId(d));
/** Whether the raw transaction carries exactly this notice's anchor output. */
export function carriesAnchor(raw, d) {
  const want = toHex(departureAnchorScript(d));
  return parseTransaction(raw instanceof Uint8Array ? raw : fromHex(String(raw))).outputs.some((o) => toHex(o.script) === want);
}
const txidOfRaw = (raw) => toHex(Uint8Array.from(parseTransaction(raw instanceof Uint8Array ? raw : fromHex(String(raw))).txid).reverse());

export function createDepartureAnchors({ wallet = null, chain = null, confirmedTx = null, publish = async () => ({ postedTo: 0, of: 0 }), store = null, depth = 1, log = () => {}, nowMs = () => Date.now() }) {
  let records = {};
  try { const was = store ? store.read() : null; if (was && typeof was === 'object' && was.anchors) records = was.anchors; } catch { records = {}; }
  const save = () => { if (store) store.write({ anchors: records }); };
  // ONE STEP AT A TIME: the minute's pass, a Leave and the owner's command never run side by side (two would both see "no record")
  let queue = Promise.resolve();
  const serial = (fn) => { const r = queue.then(fn, fn); queue = r.catch(() => {}); return r; };
  const view = (r) => (r ? { id: r.id, phase: r.phase, txid: r.txid, blockHash: r.blockHash || null, height: Number.isInteger(r.height) ? r.height : null,
    feeSats: r.feeSats ?? null, wallet: r.wallet || null, postedTo: r.postedTo ?? null, of: r.of ?? null, why: r.why || null } : null);

  async function sendAgain(r) {
    if (!r.hex || !wallet || typeof wallet.send !== 'function') return;
    try { await wallet.send(r.hex); if (r.phase === P.BUILT) r.phase = P.SENT; r.why = null; }
    catch (e) { if (ALREADY.test(`${e && e.message} ${e && e.stderr}`)) { if (r.phase === P.BUILT) r.phase = P.SENT; } else r.why = `sent again, refused: ${String(e && e.message).split('\n')[0].slice(0, 200)}`; }
  }
  // WHERE IT CONFIRMED: the wallet's own word if it has one, else the node's chain read block by block from the height it was built at
  async function locate(r) {
    if (wallet && typeof wallet.where === 'function' && r.wallet === wallet.name) {
      let w = null; try { w = await wallet.where(r.txid); } catch { w = null; }
      if (w && w.blockHash) return w;
    }
    if (!chain || typeof chain.tip !== 'function' || typeof chain.blockAt !== 'function') return null;
    const tip = Number(await chain.tip());
    const from = Math.max(Number(r.sinceHeight) || 0, (Number.isInteger(r.scannedTo) ? r.scannedTo + 1 : 0));
    for (let h = from; h <= tip && h < from + SCAN_MAX; h++) {
      const b = await chain.blockAt(h);
      if (!b) break;
      if ((b.txids || []).includes(r.txid)) return { blockHash: String(b.hash), height: h };
      r.scannedTo = Math.max(Number(r.sinceHeight) || 0, Math.min(h, tip - RESCAN));
    }
    return null;
  }
  async function deepEnough(height) {
    if (!(depth > 1) || !chain || typeof chain.tip !== 'function') return true;
    return Number(await chain.tip()) - height + 1 >= depth;
  }

  /** One record moved as far as it goes now. */
  // `fresh`: just sent by anchor() - not sent a second time in the same breath
  async function step(r, { fresh = false } = {}) {
    const d = readDepartureHex(r.notice);
    if (r.phase === P.BUILT || r.phase === P.SENT) {
      const at = await locate(r);
      if (!at) { if (!fresh) await sendAgain(r); save(); return r; }
      if (!(await deepEnough(at.height))) { r.why = `confirmed at ${at.height}, waiting for ${depth} confirmations`; save(); return r; }
      // READ AS EVERY SEAT READS IT: this node's bitcoind, the block on its main chain, the anchor of this notice in that transaction
      const read = await readAnchor({ ...d, anchor: { txid: r.txid, blockHash: at.blockHash } }, confirmedTx);
      if (!read.anchor || !Number.isInteger(read.anchor.height)) { r.why = `found in block ${at.blockHash} but it does not read as this notice's anchor on this node's chain`; save(); return r; }
      Object.assign(r, { phase: P.CONFIRMED, blockHash: at.blockHash, height: read.anchor.height, why: null });
      save();
      log(`[owner] departure anchor ${r.txid.slice(0, 16)} confirmed at ${r.height} for notice ${r.id.slice(0, 16)}`);
    }
    if (r.phase === P.CONFIRMED) {
      let p = null; try { p = await publish({ ...d, anchor: { txid: r.txid, blockHash: r.blockHash } }); } catch (e) { r.why = `not published: ${e.message}`; }
      if (p) {
        Object.assign(r, { postedTo: p.postedTo ?? 0, of: p.of ?? 0 });
        if (p.postedTo > 0 || p.of === 0) { r.phase = P.PUBLISHED; r.why = null; log(`[owner] departure notice ${r.id.slice(0, 16)} published with its anchor (height ${r.height}) to ${r.postedTo} of ${r.of} seats`); }
        else r.why = 'no seat took the anchored notice yet: posted again at the next pass';
      }
      save();
      return r;
    }
    if (r.phase === P.PUBLISHED && typeof confirmedTx === 'function' && chain && typeof chain.tip === 'function') {
      // A REORG: the anchor's block left this node's main chain - the same transaction is looked for again, and the notice published again
      const tip = Number(await chain.tip());
      if (tip - r.height < REORG_WATCH) {
        let tx = null; try { tx = await confirmedTx(r.txid, r.blockHash); } catch { tx = undefined; }
        if (tx === null) {
          Object.assign(r, { phase: P.SENT, blockHash: null, height: null, scannedTo: null, why: 'its block left this node\'s chain: looked for again' });
          save();
          log(`[owner] departure anchor ${r.txid.slice(0, 16)}: its block left the chain, looked for again`);
        }
      }
    }
    return r;
  }

  /**
   * THIS NOTICE'S ANCHOR, POSTED ONCE: the record if there is one (moved on), else built from the wallet, written, sent. `adopt`
   * { txid, sinceHeight? }: a transaction the operator sent by hand - recorded and watched as if this node had sent it (no bytes to resend).
   */
  function anchor(dIn, { adopt = null } = {}) {
    return serial(async () => {
      const d = strip(dIn);
      const id = anchorIdOf(d);
      let r = records[id];
      if (r) return view(await step(r));
      const tip = chain && typeof chain.tip === 'function' ? Number(await chain.tip()) : 0;
      if (adopt) {
        const txid = String(adopt.txid || '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(txid)) return { ok: false, why: 'name the anchor transaction by its 64-hex txid' };
        const since = Number.isInteger(adopt.sinceHeight) ? adopt.sinceHeight : Math.max(0, tip - SCAN_MAX);
        r = records[id] = { id, notice: departureHex(d), phase: P.SENT, txid, hex: null, feeSats: null, wallet: 'by hand', sinceHeight: since, atMs: nowMs() };
        save();
        return view(await step(r));
      }
      if (!wallet || typeof wallet.build !== 'function') return { ok: false, why: 'this node names no wallet to fund the anchor from (ARENA_BOND_CLI, or an installed node\'s own): send OP_RETURN '
        + `${toHex(departureAnchorScript(d))} by hand and hand its txid to POST /owner/departure-anchor` };
      let b; try { b = await wallet.build(d); } catch (e) { b = { ok: false, why: e.message.split('\n')[0] }; }
      if (!b || !b.ok) return { ok: false, why: (b && b.why) || 'the wallet built no anchor' };
      if (!carriesAnchor(b.hex, d)) return { ok: false, why: 'the wallet built a transaction without this notice\'s anchor: nothing sent' };
      const txid = txidOfRaw(b.hex);
      // WRITTEN BEFORE IT IS SENT: a crash after the broadcast finds the bytes here and sends the same ones again
      r = records[id] = { id, notice: departureHex(d), phase: b.sent ? P.SENT : P.BUILT, txid, hex: b.hex, feeSats: b.feeSats != null ? String(b.feeSats) : null,
        wallet: wallet.name || 'wallet', sinceHeight: Math.max(0, tip - 1), atMs: nowMs() };
      save();
      if (!b.sent) await sendAgain(r);
      save();
      log(`[owner] departure anchor ${txid.slice(0, 16)} sent for notice ${id.slice(0, 16)} (fee ${r.feeSats ?? '?'} sat, ${r.wallet})`);
      return view(await step(r, { fresh: true }));
    });
  }
  /** Every record not yet through moved on (the minute's pass). */
  const pass = () => serial(async () => { const out = []; for (const r of Object.values(records)) { try { out.push(view(await step(r))); } catch (e) { out.push({ ...view(r), why: e.message }); } } return out; });
  const recordOf = (d) => view(records[typeof d === 'string' ? d.toLowerCase() : anchorIdOf(d)]);
  const list = () => Object.values(records).map(view);
  /** What would be posted for `d`: the anchor's script, and the record if there is one. */
  const planOf = (d) => ({ id: anchorIdOf(d), script: toHex(departureAnchorScript(strip(d))), payload: toHex(encodeDepartureAnchor(strip(d))), record: recordOf(strip(d)), wallet: wallet ? wallet.name : null });
  return { anchor, pass, recordOf, list, planOf };
}

/**
 * THE BOND WALLET (ARENA_BOND_CLI, add-bond-wallet.js bondCliFrom): a Bitcoin Core wallet funds a transaction whose one output is the
 * anchor (walletcreatefundedpsbt, `data`), signs it and checks it with testmempoolaccept; the fee from the same wallet at ANCHOR_FEE_RATE.
 */
export function bondCliAnchorWallet(cli, { feeRate = ANCHOR_FEE_RATE } = {}) {
  const j = (...a) => JSON.parse(cli(...a));
  return {
    name: 'bond wallet',
    async build(d) {
      let funded;
      try { funded = j('-named', 'walletcreatefundedpsbt', 'inputs=[]', `outputs=${JSON.stringify([{ data: toHex(encodeDepartureAnchor(d)) }])}`, `options=${JSON.stringify({ fee_rate: feeRate })}`); }
      catch (e) {
        if (/Insufficient funds/i.test(`${e.stderr || ''} ${e.message}`)) return { ok: false, why: 'the bond wallet holds too little to pay the anchor\'s fee: top it up first' };
        throw e;
      }
      const final = j('finalizepsbt', j('walletprocesspsbt', funded.psbt).psbt);
      if (!final.complete || !final.hex) return { ok: false, why: 'the bond wallet did not sign the anchor' };
      const accept = j('testmempoolaccept', JSON.stringify([final.hex]));
      if (!accept.every((a) => a.allowed)) return { ok: false, why: `the network would refuse it (${accept.map((a) => a['reject-reason']).filter(Boolean).join(', ')}); nothing was sent` };
      return { ok: true, hex: final.hex, feeSats: BigInt(Math.round(Number(funded.fee) * 1e8)) };
    },
    async send(hex) { return cli('sendrawtransaction', hex); },
    async where(txid) {
      let t; try { t = j('gettransaction', txid); } catch { return null; }
      return Number(t.confirmations) > 0 && t.blockhash ? { blockHash: String(t.blockhash), height: Number(t.blockheight) } : null;
    },
  };
}

/**
 * AN INSTALLED NODE'S OWN WALLET (ARENA_HOME: the wallet the wizard funded, arena-installer wallet.js): the anchor paid as any other payment of
 * that wallet - an on-chain action (onchain-action.js, kanban #1165), `once` per notice, so the installer's own journal never builds it twice
 * either. `state`, `seed`, `chainKit` may be given (tests); by default read from the home.
 */
export async function installerAnchorWallet({ home = null, state = null, seed = null, chainKit = null, feeRate = ANCHOR_FEE_RATE } = {}) {
  const { nodeState } = await import('../../arena-installer/src/state.js');
  const wl = await import('../../arena-installer/src/wallet.js');
  const { buildSend } = await import('../../arena-installer/src/bond.js');
  const { onchainAction } = await import('../../arena-installer/src/onchain-action.js');
  const st = state || nodeState(home);
  const kit = chainKit || { coinsOf: wl.coinsOf, broadcast: wl.broadcast, seen: wl.txSeen };
  const seedOf = () => { if (seed) return seed; const h = st.readSecret('seed.hex'); return h ? fromHex(h) : null; };
  return {
    name: 'node wallet',
    async build(d) {
      const sd = seedOf();
      if (!sd) return { ok: false, why: 'the wallet seed is not in this node\'s home' };
      const w = wl.walletOf(sd);
      const script = departureAnchorScript(d);
      const r = await onchainAction({ state: st, kind: `departure-anchor ${anchorIdOf(d).slice(0, 32)}`, once: true, chainKit: kit,
        build: async (s) => {
          const { tip, coins } = await kit.coinsOf(s.chain, w.spk);
          let tx; try { tx = buildSend({ wallet: w, coins, script, sats: 0n, feeRate }); } catch (e) { return { ok: false, why: e.message }; }
          return { ok: true, tip, txs: [{ name: 'departure-anchor', hex: tx.hex }], ops: [], result: { txid: tx.txid, hex: tx.hex, feeSats: String(tx.fee) } };
        } });
      if (!r.ok) return { ok: false, why: r.why };
      return { ok: true, hex: r.result.hex, feeSats: r.result.feeSats, sent: true };
    },
    async send(hex) { return kit.broadcast(st.read().chain, hex); },
  };
}

/** A JSON file as the record store, written whole through a temporary file and a rename (never half a file). */
export function fileStore(path, { readFileSync, writeFileSync, renameSync }) {
  return {
    read: () => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } },
    write: (v) => { const tmp = `${path}.tmp`; writeFileSync(tmp, JSON.stringify(v)); renameSync(tmp, path); },
  };
}
