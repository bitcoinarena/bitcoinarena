// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN EXISTING NODE MOVES TO THE KEY ITS 24 WORDS GIVE (kanban #650, 2026-10-25: the node key from the words - "b but optional"):
// a node installed before 2026.1.8 signs with a random key kept only in its node.db, so a machine lost with that file loses the node and
// its bond even with the words. This optional owner-page action gives it the key the words give (seed.js nodeKeyOf, what a new install
// adopts): a new bond posted under that key from the node's wallet, the same amount as the bond it has, with the node's advertisement
// as it stands; then the node signs with the new key. The old bond stays where it is, under the old key, kept beside the store
// (identity_old) and in the state's oldBonds, to be taken back after its maturity. Never forced; refused where it would break something:
// a Nostr node (its key is its nsec), a guardian holding a seat (its federation knows its key), no bond yet, or not enough coins.
// Answers { ok, plan } / { ok, plan, bond } or { ok: false, why }.
// THE MOVE IS AN ON-CHAIN ACTION (kanban #1165, onchain-action.js), once per key moved from: the new bond's bytes written before they are
// sent; then the key swap - identity_old and identity in ONE SQLite transaction, only from the key it was built from - then the state.
// A crash anywhere is finished at the next ask (the owner page asks on every load), never a second new bond.
// AND THE OLD KEY STEPS OUT (kanban #1776, state audit 2026-11-12): after the swap nothing signs as the old key, but its bond stays
// unspent and locked to its maturity with an advertisement that says serving = true, so every census until then drew a node that never
// answered. The same action now carries, after the new bond, one advertisement update per old bond output, signed by the old key, with
// serving = false (§5A.3, what tools/testnet4-step-out.mjs did by hand), paid from the new bond's change: built and written with the
// bond's bytes, so a crash re-sends them and the move is never half a step-out. Too few coins for them refuses the move as a whole.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { walletOf, payoutKeyOf, coinsOf, broadcast, txSeen } from './wallet.js';
import { buildBond, buildAdvertUpdate, advertFor, lockOf, censusKeyOfNode, bondNetworkOf, EMERGENCY_IN_ADVERT } from './bond.js';
import { emergencyOf, nodeKeyOf } from './seed.js';
import { nodeState, bondsOf } from './state.js';
import { fromHex, toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { onchainAction, resumeOpen, lastActionOf } from './onchain-action.js';

// THE SEAT RESTART IS OWED BY THE MOVE, NOT BY THE DOOR (kanban #2297): the seat reads its key from node.db once, at start, and only
// POST /owner/key-from-words restarts it - on an answer with `bond`. A move whose key swap was busy (SQLITE_BUSY) stays open and is
// finished by whichever door of the wallet comes first (resumeOpen: Add to bond, the roles, the games refresh, the custody agent), none
// of which restarts the seat; from then on node.db holds the words' key and the move was answered { already } forever, so the seat kept
// signing as the old key. Now the move's DONE record writes keySwitch.restart (one locked write with the new bond and node.db already
// swapped); every ask answers that move with its bond while the mark stands, and the answer that carries the bond takes the mark away
// (compare-and-set on the bond) - so the restart is owed until a door is told to do it, whoever finished the move.
const restartOwed = (s) => { const k = s.keySwitch; return k && k.restart && typeof k.from === 'string' ? k : null; };
function answerMove(st, plan, bond, extra = {}) {
  st.update((n) => { const k = restartOwed(n); return k && k.bond === bond.txid ? { keySwitch: { ...k, restart: false, restartAskedMs: Date.now() } } : null; });
  return { ok: true, plan, bond, ...extra };
}

export async function switchToSeedKey({ home, release, post = false, chainKit = { coinsOf, broadcast, seen: txSeen }, state = null, nowMs = Date.now() }) {
  const st = state || nodeState(home);
  // a move sent before and not finished (a crash between the broadcast and the key swap): finished first - the seat restarts on its answer
  const resumed = await resumeOpen(st, { chainKit });
  if (resumed.done && resumed.done.kind.startsWith('key-switch ') && resumed.done.result) return answerMove(st, resumed.done.result.plan, resumed.done.result.bond, { resumed: true });
  const s = st.read();
  // a move finished by another door (kanban #2297): its restart still owed - answered with its bond, so the door restarts the seat
  {
    const k = restartOwed(s), last = k && lastActionOf(s, `key-switch ${k.from}`);
    if (last && last.phase === 'done' && last.result && last.result.bond && last.result.bond.txid === k.bond) return answerMove(st, last.result.plan, last.result.bond, { resumed: true });
  }
  if (s.control === 'nostr') return { ok: false, why: 'this node runs on your Nostr key: its key is your nsec, not your 24 words' };
  const outputs = bondsOf(s);
  if (!outputs.length) return { ok: false, why: 'this node has no bond yet: its bond will be posted under the key from your words' };
  if ((s.custody || {}).guardianOf || (s.roles || []).includes('custody') && s.federation)
    return { ok: false, why: 'a guardian keeps its key while it holds a seat: its federation knows it by that key. Leave custody first' };
  const seedHex = st.readSecret('seed.hex');
  if (!seedHex) return { ok: false, why: 'the wallet seed is not in this node\'s home' };
  const seed = fromHex(seedHex.trim());
  const next = nodeKeyOf(seed);
  let now;
  {
    const db = new DatabaseSync(st.path('node.db'), { readOnly: true });
    try { const row = db.prepare('SELECT secret FROM identity WHERE one = 0').get(); now = row ? new Uint8Array(row.secret) : null; } finally { db.close(); }
  }
  if (!now) return { ok: false, why: 'this node has no key yet: start it once' };
  const nowPub = toHex(schnorr.getPublicKey(now)), nextPub = toHex(schnorr.getPublicKey(next));
  if (nowPub === nextPub) return { ok: true, already: true, key: nowPub };
  const w = walletOf(seed);
  const planOf = async (s) => {
    const outputs = bondsOf(s);
    const bondSats = outputs.reduce((a, b) => a + BigInt(b.sats), 0n);
    const { tip, coins } = await chainKit.coinsOf(s.chain, w.spk);
    let softwareHash; try { softwareHash = sha256(readFileSync(join(release, 'COMMIT'))); } catch { softwareHash = new Uint8Array(32); }
    const censusKey = await censusKeyOfNode(s);
    let built;
    try {
      built = buildBond({ network: bondNetworkOf(s), hostedGames: s.hostedGames, hostGroup: s.hostGroup, wallet: w, nodeSecret: next, coins, tip, bondSats, operatorId: `op-${s.owner.pubkey.slice(0, 12)}`,
        roles: s.roles, endpoint: s.reach.url, payoutPubkey: payoutKeyOf(seed), softwareHash, nowMs, censusKey,
        emergencyPubkey: EMERGENCY_IN_ADVERT ? fromHex(emergencyOf(seed).pubkey) : null });
    } catch (e) { return { ok: false, why: `${e.message} - the new bond needs ${bondSats} sat plus fees in the node's wallet (${w.address})` }; }
    // kanban #1776: each old bond output stepped out (serving = false) under the old key, chained on the new bond's change
    const stepOuts = [];
    let coin = built.changeSats > 0n ? { txid: built.bond.txid, vout: 3, sats: built.changeSats } : null;
    for (const b of outputs) {
      const advert = { ...advertFor({ hostGroup: s.hostGroup, hostedGames: s.hostedGames, nodeKey: schnorr.getPublicKey(now), operatorId: `op-${s.owner.pubkey.slice(0, 12)}`, roles: s.roles,
        endpoint: s.reach.url, payoutPubkey: payoutKeyOf(seed), maturity: b.maturity, softwareHash, nowMs,
        emergencyPubkey: EMERGENCY_IN_ADVERT ? fromHex(emergencyOf(seed).pubkey) : null }), serving: false };
      let u;
      try {
        if (!coin) throw new Error('the new bond leaves no change');
        u = buildAdvertUpdate({ wallet: w, nodeSecret: now, coins: [coin], bond: { txid: b.txid, vout: b.vout || 0 }, advert });
      } catch (e) { return { ok: false, why: `${e.message} - stepping the old key out of the census (one advertisement update per old bond) needs a few thousand sat more in the node's wallet (${w.address})` }; }
      stepOuts.push(u);
      coin = u.changeSats > 0n ? { txid: u.update.txid, vout: 2, sats: u.changeSats } : null;
    }
    const plan = { keyNow: nowPub, keyNext: nextPub, bondSats: String(bondSats), maturity: built.maturity, lock: lockOf(tip, { maturity: built.maturity }),
      fees: String(stepOuts.reduce((a, u) => a + u.fees.funding + u.fees.update, built.fees.funding + built.fees.bond)),
      stepOuts: stepOuts.map((u) => u.update.txid), oldBonds: outputs.map((b) => ({ txid: b.txid, vout: b.vout || 0, sats: String(b.sats), maturity: b.maturity })),
      wallet: w.address, tip, countsAfter: 6 };
    return { ok: true, plan, built, stepOuts, tip, outputs };
  };
  if (!post) { const p = await planOf(s); return p.ok ? { ok: true, plan: p.plan } : p; }
  const kind = `key-switch ${nowPub}`;
  const r = await onchainAction({ state: st, kind, once: true, chainKit,
    build: async (s2) => {
      const p = await planOf(s2);
      if (!p.ok) return p;
      const { built, stepOuts, tip, plan, outputs } = p;
      const bond = { txid: built.bond.txid, vout: 0, fundingTxid: built.funding.txid, sats: String(built.bondSats), maturity: built.maturity, advertId: built.advertId, postedAtTip: tip,
        lock: plan.lock, atMs: nowMs, ...(built.presigUpdate ? { censusKey: built.censusKey, presigUpdate: built.presigUpdate.txid } : {}) };
      // the old key kept beside the store, so its bond can be taken back at its maturity (the effect); then the node signs with the new one
      return { ok: true, tip, txs: [{ name: 'funding', hex: built.funding.hex }, { name: 'bond', hex: built.bond.hex }, built.presigUpdate ? { name: 'presig', hex: built.presigUpdate.hex } : null,
        ...stepOuts.flatMap((u) => [{ name: 'step-out funding', hex: u.funding.hex }, { name: 'step-out', hex: u.update.hex }])],
        effect: 'key-switch', meta: { from: nowPub, to: nextPub },
        ops: [{ op: 'set', key: 'bond', value: bond }, { op: 'set', key: 'bonds', value: [bond] }, { op: 'push', key: 'oldBonds', values: outputs.map((b) => ({ ...b, key: nowPub })) },
          { op: 'set', key: 'identityFromSeed', value: true }, { op: 'set', key: 'keySwitch', value: { from: nowPub, to: nextPub, bond: bond.txid, atMs: nowMs, restart: true } }],
        result: { plan, bond } };
    } });
  if (!r.ok) return r;
  return answerMove(st, r.result.plan, r.result.bond, r.already ? { already: true } : {});
}
