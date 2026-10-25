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
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { walletOf, payoutKeyOf, coinsOf, broadcast } from './wallet.js';
import { buildBond, lockOf, EMERGENCY_IN_ADVERT } from './bond.js';
import { emergencyOf, nodeKeyOf } from './seed.js';
import { nodeState, bondsOf } from './state.js';
import { fromHex, toHex, sha256 } from '../../arena-protocol/src/hash.js';

export async function switchToSeedKey({ home, release, post = false, chainKit = { coinsOf, broadcast }, state = null, nowMs = Date.now() }) {
  const st = state || nodeState(home);
  const s = st.read();
  if (s.control === 'nostr') return { ok: false, why: 'this node runs on your Nostr key: its key is your nsec, not your 24 words' };
  const outputs = bondsOf(s);
  if (!outputs.length) return { ok: false, why: 'this node has no bond yet: its bond will be posted under the key from your words' };
  if ((s.custody || {}).guardianOf || (s.roles || []).includes('custody') && s.federation)
    return { ok: false, why: 'a guardian keeps its key while it holds a seat: its federation knows it by that key. Leave custody first' };
  const seedHex = st.readSecret('seed.hex');
  if (!seedHex) return { ok: false, why: 'the wallet seed is not in this node\'s home' };
  const seed = fromHex(seedHex.trim());
  const next = nodeKeyOf(seed);
  const db = new DatabaseSync(st.path('node.db'), { readOnly: !post });
  try {
    const row = db.prepare('SELECT secret FROM identity WHERE one = 0').get();
    if (!row) return { ok: false, why: 'this node has no key yet: start it once' };
    const now = new Uint8Array(row.secret);
    const nowPub = toHex(schnorr.getPublicKey(now)), nextPub = toHex(schnorr.getPublicKey(next));
    if (nowPub === nextPub) return { ok: true, already: true, key: nowPub };
    const bondSats = outputs.reduce((a, b) => a + BigInt(b.sats), 0n);
    const w = walletOf(seed);
    const { tip, coins } = await chainKit.coinsOf(s.chain, w.spk);
    let softwareHash; try { softwareHash = sha256(readFileSync(join(release, 'COMMIT'))); } catch { softwareHash = new Uint8Array(32); }
    let built;
    try {
      built = buildBond({ hostedGames: s.hostedGames, wallet: w, nodeSecret: next, coins, tip, bondSats, operatorId: `op-${s.owner.pubkey.slice(0, 12)}`,
        roles: s.roles, endpoint: s.reach.url, payoutPubkey: payoutKeyOf(seed), softwareHash, nowMs,
        emergencyPubkey: EMERGENCY_IN_ADVERT ? fromHex(emergencyOf(seed).pubkey) : null });
    } catch (e) { return { ok: false, why: `${e.message} - the new bond needs ${bondSats} sat plus fees in the node's wallet (${w.address})` }; }
    const plan = { keyNow: nowPub, keyNext: nextPub, bondSats: String(bondSats), maturity: built.maturity, lock: lockOf(tip, { maturity: built.maturity }),
      fees: String(built.fees.funding + built.fees.bond), oldBonds: outputs.map((b) => ({ txid: b.txid, vout: b.vout || 0, sats: String(b.sats), maturity: b.maturity })),
      wallet: w.address, tip, countsAfter: 6 };
    if (!post) return { ok: true, plan };
    const fundingTxid = await chainKit.broadcast(s.chain, built.funding.hex);
    const bondTxid = await chainKit.broadcast(s.chain, built.bond.hex);
    // the old key kept beside the store, so its bond can be taken back at its maturity; then the node signs with the new one
    db.exec('CREATE TABLE IF NOT EXISTS identity_old (secret BLOB NOT NULL, pubkey BLOB NOT NULL, at_ms INTEGER NOT NULL)');
    db.prepare('INSERT INTO identity_old (secret, pubkey, at_ms) VALUES (?, ?, ?)').run(now, fromHex(nowPub), nowMs);
    db.prepare('UPDATE identity SET secret = ?, pubkey = ? WHERE one = 0').run(next, fromHex(nextPub));
    const bond = { txid: bondTxid, vout: 0, fundingTxid, sats: String(built.bondSats), maturity: built.maturity, advertId: built.advertId, postedAtTip: tip,
      lock: plan.lock, atMs: nowMs };
    st.save({ bond, bonds: [bond], oldBonds: [...(s.oldBonds || []), ...outputs.map((b) => ({ ...b, key: nowPub }))], identityFromSeed: true,
      keySwitch: { from: nowPub, to: nextPub, bond: bondTxid, atMs: nowMs } });
    return { ok: true, plan, bond };
  } finally { db.close(); }
}
