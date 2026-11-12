// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489, #1667, #1731 wf1489-v1-refute-2-s1-3: seats that sign their asks keep their own pair at every peer, so a stranger who fills the open pool
// before and floods it after every ask, and replays the seats' own signed asks, neither drops a seat's pair nor spends it on a list of its own.
// (fixture copied from settlement-withheld-share.test.js)
// ONE WITHHELD SHARE DOES NOT PIN A SETTLEMENT (kanban #1070). A seat keeps one nonce pair per settlement, and the pair signs one commitment list. A seat that committed
// and then gives no share therefore left every seat that had already signed that list refusing any other ("keeps no second pair") until it restarted, and the seat that
// went on committing was put back on every next list: one seat stopped a settlement the five others could sign.
//
// Seven real LockSettlement instances with a real 5-of-7 FROST key: each seat's own commit, share and take, reached through a fetcher that answers as server.js does, and
// misbehaves for the seats a test names. Only the settlement's bytes are stubbed (`message`), not the signing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';

import { LockSettlement, encodeCommitments, encodeShare, decodeCommitments, PAIRS_KEPT } from '../src/settlement.js';
import * as curve from '../src/curve.js';
import { evenGroupSecret } from '../../arena-protocol/src/frost-bip340.js';
import { trustedDealerSplit } from '../../arena-protocol/src/frost.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { sha256, toHex, fromHex } from '../../arena-protocol/src/hash.js';

const RID = new Uint8Array(32).fill(0x70);
const MSG = new Uint8Array(32).fill(0xac);
const TXID = toHex(MSG);
const ENTRY = new Uint8Array(32).fill(0x71);
const FED = 'fe'.repeat(32);
const GROUP = evenGroupSecret(0x1070n, curve);
const DEAL = trustedDealerSplit({ secret: GROUP.secret, max: 7, min: 5, coefficients: [5n, 6n, 7n, 8n], curve });
const SECRETS = [0, 1, 2, 3, 4, 5, 6].map((k) => sha256(Uint8Array.from([0x67, k])));
const NODES = SECRETS.map((s) => schnorr.getPublicKey(s));
const PUBLIC_SHARES = new Map(DEAL.shares.map((s) => [String(s.id), curve.pointFromScalar(s.share)]));

const base = (k) => `http://seat${k}`;
const seatOf = (u) => Number(new URL(u).hostname.slice(4));

/** What a stub round keeps, enough for a settlement, a late settlement and one federation's. */
function stubRound(k) {
  const rows = { settlement: null, late: null, fed: null };
  return { identity: { secret: SECRETS[k] }, pubkey: NODES[k],
    get: () => null, lockSettlement: () => rows.settlement, putLockSettlement: (r) => { rows.settlement = r; }, putLockSettlementMoves: () => {},
    lateLockSettlement: () => rows.late, putLateLockSettlement: (r) => { rows.late = r; },
    fedLockSettlement: () => rows.fed, putFedLockSettlement: (r) => { rows.fed = r; },
    rows,
  };
}

/** The seven seats. `misbehave(k, path, url)` answers for seat k at that door or throws as a dropped connection; undefined is the honest door. */
function seven({ misbehave = () => undefined, seed = 0x70 } = {}) {
  const seats = [];
  const port = { settled: [], settle: async (x) => { port.settled.push(x); return { accepted: true, payoutsStored: [{ id: 'payout-0' }], locksAfter: [null] }; } };   // as the tool answers (kanban #1171)
  const refusals = [];
  for (let k = 0; k < 7; k++) {
    let drawn = 0;
    // the draw counter in three bytes (kanban #1489 merge19v1): one byte wrapped after 256 draws and repeated a pair, which the nonce pool refuses (#2011)
    const random = (n) => { const d = drawn++; return sha256(Uint8Array.from([seed, k, d & 255, (d >> 8) & 255, (d >> 16) & 255, n])); };
    const round = stubRound(k);
    const peers = [0, 1, 2, 3, 4, 5, 6].filter((j) => j !== k).map(base);
    const s = new LockSettlement(round, { curve, random, port, peersFor: () => peers, dkg: { publicSharesFor: () => ({ ok: true, shares: PUBLIC_SHARES }) },
      fetcher: async (u, o) => {
        const url = new URL(u);
        const to = seatOf(u);
        const own = misbehave(to, url.pathname, url);
        if (own !== undefined) return own;
        const r = await serve(seats[to], url, o && o.body ? new Uint8Array(o.body) : new Uint8Array(), (o && o.headers) || {});
        if (!r.ok) refusals.push(`${k}->${to} ${url.pathname}: ${await r.clone().text()}`);
        return r;
      } });
    const bytes = { ok: true, txid: TXID, message: MSG, claimPk: DEAL.groupPublicKey, needed: 5, claims: [], contract: { nodes: NODES },
      plan: { payouts: [], claims: [], nonce: new Uint8Array(32), stakeShares: [] }, signerNode: { id: DEAL.shares[k].id, share: DEAL.shares[k].share } };
    s.message = async () => bytes;
    s.lateMessage = async () => bytes;
    s.fedMessage = async () => bytes;
    s.turn = async () => ({ mine: true, place: k });
    seats.push(s);
  }
  return { seats, port, refusals };
}

// WHAT server.js ANSWERS at /settle-commit, /settle-share and /settle-signature
async function serve(seat, url, body, headers = {}) {
  const ask = headers['x-send-plan-ask'] || null;
  const rid = fromHex(url.searchParams.get('round'));
  const hex = url.searchParams.get('entry');
  const scope = { entry: hex ? fromHex(hex) : null, federation: url.searchParams.get('federation'), ask };
  if (url.pathname === '/settle-commit') {
    const got = await seat.commit(rid, { txid: url.searchParams.get('txid'), ...scope });
    return got.ok ? new Response(encodeCommitments([got.commitment])) : new Response(got.why, { status: got.status || 409 });
  }
  if (url.pathname === '/settle-share') {
    const got = await seat.share(rid, decodeCommitments(body), scope);
    return got.ok ? new Response(encodeShare(got.share)) : new Response(got.why, { status: got.status || 409 });
  }
  if (url.pathname === '/settle-signature') {
    const got = await seat.take(rid, body, scope);
    return got.ok ? new Response('kept', { status: 201 }) : new Response(got.why, { status: 409 });
  }
  throw new Error(`no such door ${url.pathname}`);
}


const signedOver = (w) => w.port.settled.map((x) => schnorr.verify(x.signature, MSG, DEAL.groupPublicKey.subarray(1)));

test('#1667 #1731: a stranger fills the open pool, floods it after every ask, replays the seats\' signed asks and spends what it gets - the settlement still signs at once', async () => {
  let w;
  let drawn = 0, spent = 0, full = 0;
  const invented = [0, 1, 2, 3].map((i) => ({ hiding: curve.pointFromScalar(BigInt(5000 + i)), binding: curve.pointFromScalar(BigInt(6000 + i)) }));
  const steal = async (k, url, headers) => {
    const c = await serve(w.seats[k], url, new Uint8Array(), headers);
    if (!c.ok) { if (c.status === 429) full++; return; }
    drawn++;
    const own = decodeCommitments(new Uint8Array(await c.arrayBuffer()))[0];
    const others = DEAL.shares.map((s) => s.id).filter((id) => id !== own.id).slice(0, 4).map((id, i) => ({ id, ...invented[i] }));
    const su = new URL(url); su.pathname = '/settle-share';
    // the replayed header was signed over another list, so it does not stand here; the stranger tries it and then unsigned
    for (const h of [headers, {}]) { const r = await serve(w.seats[k], su, encodeCommitments([own, ...others].sort((a, b) => a.id - b.id)), h); if (r.ok) { spent++; break; } }
  };
  w = seven({ misbehave: (k, path, url) => undefined });
  // THE POOL FULL BEFORE ANYONE ASKS: PAIRS_KEPT unsigned commits at every seat, none spent
  const pre = `http://seat0/settle-commit?round=${toHex(RID)}&txid=${TXID}`;
  for (let k = 0; k < 7; k++) for (let i = 0; i < PAIRS_KEPT; i++) { const r = await serve(w.seats[k], new URL(pre), new Uint8Array()); if (r.ok) drawn++; }
  // AND AFTER EVERY ASK: the stranger replays the asker's own signed ask, then floods unsigned, spending each pair on a list of its own
  const orig = w.seats.map((s) => s.fetcher);
  w.seats.forEach((s, i) => { s.fetcher = async (u, o) => {
    const url = new URL(u);
    const r = await orig[i](u, o);
    if (url.pathname === '/settle-commit') { const to = Number(url.hostname.slice(4)); await steal(to, url, (o && o.headers) || {}); for (let j = 0; j < PAIRS_KEPT; j++) await steal(to, url, {}); }
    return r;
  }; });
  const got = await w.seats[0].settle(RID).catch((e) => ({ ok: false, why: e.message }));
  console.log(`  FACTS: stranger drew ${drawn} pairs, spent ${spent}, refused ${full} at a full pool; pass: ${got.state || 'refused'} ${String(got.why || '').slice(0, 90)}`);
  assert.equal(got.state, 'ACCEPTED', `the stranger kept the round unsettled: ${got.why}`);
  assert.deepEqual(signedOver(w), [true]);
  // (kanban #1489 merge19v1: item 2's open pool refused unsigned asks once full; the 1.9 line keeps item 27's nonce-pool.js, where a full pool
  // refuses no commit and makes room instead (#2011) - `full` is 0 there. What the hole is about holds above: the settlement signs at once)
});

test('#1667 #1731: an ask signed by a key that is not a seat of the round, or over other bytes, gets nothing a seat gets: an open-pool pair per ask, which its signed share cannot spend', { todo: 'kanban #1489 merge19v1: drives nonce-pairs.js (signed asks per seat slot, item 2), which the 1.9 line does not take - the forfeit, settlement and send doors keep their pairs in nonce-pool.js (item 27, #1996/#2011/#2044), the same hole' }, async () => {
  const w = seven();
  const url = new URL(`http://seat1/settle-commit?round=${toHex(RID)}&txid=${TXID}`);
  const { pairAskHeaders } = await import('../src/nonce-pairs.js');
  const as = (secret, pubkey, part, share = false, key = toHex(RID)) => pairAskHeaders({ identity: { secret }, pubkey }, { share, roundId: RID, door: 'settle', key, part });
  const commitOf = async (h) => { const r = await serve(w.seats[1], url, new Uint8Array(), h); assert.equal(r.status, 200); return decodeCommitments(new Uint8Array(await r.arrayBuffer()))[0]; };
  const stranger = sha256(Uint8Array.from([0x99]));
  const forged = as(stranger, schnorr.getPublicKey(stranger), TXID);
  const other = as(SECRETS[0], NODES[0], 'ff'.repeat(32));
  const good = as(SECRETS[0], NODES[0], TXID);
  for (const h of [forged, other]) assert.notEqual(toHex((await commitOf(h)).hiding), toHex((await commitOf(h)).hiding), 'a signature that does not stand is an unsigned ask: a pair of its own each time');
  const a = await commitOf(good);
  const b = await commitOf(good);
  assert.equal(toHex(a.hiding), toHex(b.hiding), 'a replay of a seat\'s ask hands back its one unspent pair');
  // the seat's pair is spent only by that seat's own signed share: unsigned, or signed by a stranger, the list is refused
  const invented = [2, 3, 4, 5].map((i) => ({ id: DEAL.shares[i].id, hiding: curve.pointFromScalar(BigInt(7000 + i)), binding: curve.pointFromScalar(BigInt(8000 + i)) }));
  const list = [a, ...invented].sort((x, y) => x.id - y.id);
  const { listKey } = await import('../src/nonce-pairs.js');
  const su = new URL(url); su.pathname = '/settle-share';
  for (const h of [{}, as(stranger, schnorr.getPublicKey(stranger), listKey(list), true)]) {
    const r = await serve(w.seats[1], su, encodeCommitments(list), h);
    assert.match(await r.text(), /does not carry this signer node's own commitment/);
  }
  const r = await serve(w.seats[1], su, encodeCommitments(list), as(SECRETS[0], NODES[0], listKey(list), true));
  assert.equal(r.status, 200, 'the seat\'s own signed share spends its pair');
});
