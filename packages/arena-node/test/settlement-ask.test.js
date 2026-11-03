// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONLY THE ROUND'S SEATS MAY ASK FOR A SETTLEMENT'S COMMIT OR SHARE (§5A.3, RULED 2026-11-03, kanban #1075). Since #1070 a list made up at the open share door costs a seat only the
// pass it lands in, but someone who reaches the doors can race the asker between its commit and its share on every pass: the share door signs the made-up list, the seat's nonce
// pair is spent, and the real list is refused "keeps no second pair". The acks a 2.0 commit needs are public (the ack door stays open). From SETTLEMENT_ASK_HEIGHT a commit or share
// request carries a SettlementAsk signed by the asking seat's node key, and the asked seat answers only a seat of the round's seating.
//
// Seven real LockSettlement instances with a real 5-of-7 FROST key and real acks, reached through a fetcher that answers as server.js does (headers included). Only the
// settlement's bytes are stubbed (`message`), not the signing. The round's census height is 500 on regtest; `askPointOf` puts the height above or below it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';

import { LockSettlement, encodeCommitments, encodeShare, decodeCommitments } from '../src/settlement.js';
import * as curve from '../src/curve.js';
import { evenGroupSecret } from '../../arena-protocol/src/frost-bip340.js';
import { trustedDealerSplit } from '../../arena-protocol/src/frost.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { settlementAskPoint } from '../../arena-protocol/src/constants.js';
import { asksBySeat, signSettlementAsk, checkSettlementAsk, ASK_SHARE, ASK_COMMIT, joinAcks, splitAcks } from '../../arena-protocol/src/settlement-ack.js';
import { sha256, toHex, fromHex } from '../../arena-protocol/src/hash.js';

const RID = new Uint8Array(32).fill(0x75);
const MSG = new Uint8Array(32).fill(0xad);
const TXID = toHex(MSG);
const ENTRY = new Uint8Array(32).fill(0x76);
const CENSUS = 500;
const GROUP = evenGroupSecret(0x1075n, curve);
const DEAL = trustedDealerSplit({ secret: GROUP.secret, max: 7, min: 5, coefficients: [5n, 6n, 7n, 8n], curve });
const KEYS = [0, 1, 2, 3, 4, 5, 6].map((k) => sha256(Uint8Array.from([0x75, k])));
const NODES = KEYS.map((x) => schnorr.getPublicKey(x));
const STRANGER = sha256(Uint8Array.from([0x75, 0xff]));
const ABOVE = () => 0;               // the height named at or below the round's census: asks are signed
const BELOW = () => CENSUS + 1;      // the height above the round's census: the round settles as 1.9 left it

const base = (k) => `http://seat${k}`;
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const signer = (secret) => (digest) => schnorr.sign(digest, secret);

function stubRound(k) {
  const rows = { settlement: null, late: null };
  return {
    get: () => null, lockSettlement: () => rows.settlement, putLockSettlement: (r) => { rows.settlement = r; }, putLockSettlementMoves: () => {},
    lateLockSettlement: () => rows.late, putLateLockSettlement: (r) => { rows.late = r; },
    identity: { secret: KEYS[k] }, pubkey: NODES[k], rows,
  };
}

/**
 * The seven seats. `beforeShare(to, url, body)` runs before the asker's share request reaches seat `to` (a racing stranger); `wire` logs each request with its ask header.
 */
function seven({ askPointOf, beforeShare = async () => {}, wire = [], seed = 0x75 } = {}) {
  const contract = { protocolVersion: 22, networkId: NETWORK_ID_REGTEST, censusHeight: CENSUS, nodes: NODES, settlementSlots: 7 };
  const seats = [];
  const port = { settled: [], settle: async (x) => { port.settled.push(x); return { accepted: true }; } };
  const refusals = [];
  for (let k = 0; k < 7; k++) {
    let drawn = 0;
    const random = (n) => sha256(Uint8Array.from([seed, k, drawn++, n]));
    const peers = [0, 1, 2, 3, 4, 5, 6].filter((j) => j !== k).map(base);
    const s = new LockSettlement(stubRound(k), { curve, random, port, peersFor: () => peers, askPointOf,
      fetcher: async (u, o) => {
        const url = new URL(u);
        const to = Number(url.hostname.slice(4));
        const body = o && o.body ? new Uint8Array(o.body) : new Uint8Array();
        const ask = (o && o.headers && o.headers['x-settlement-ask']) || null;
        wire.push({ from: k, to, path: url.pathname, ask });
        if (url.pathname === '/settle-share') await beforeShare(to, url, body);
        const r = await serve(seats[to], url, body, ask);
        if (!r.ok) refusals.push(`${k}->${to} ${url.pathname}: ${await r.clone().text()}`);
        return r;
      } });
    const bytes = { ok: true, contract, ackTable: { roundId: RID, rows: [] }, txid: TXID, message: MSG, claimPk: DEAL.groupPublicKey, needed: 5, claims: [],
      plan: { payouts: [], claims: [], nonce: new Uint8Array(32), stakeShares: [] }, signerNode: { id: DEAL.shares[k].id, share: DEAL.shares[k].share } };
    s.message = async () => bytes;
    s.lateMessage = async () => bytes;
    s.turn = async () => ({ mine: true, place: k });
    seats.push(s);
  }
  return { seats, port, refusals, wire, contract };
}

// WHAT server.js ANSWERS at the settlement's doors: the ack door open to anyone, the commit and share doors with `door: true` and the x-settlement-ask header
async function serve(seat, url, body, askHex = null) {
  const rid = fromHex(url.searchParams.get('round'));
  const hex = url.searchParams.get('entry');
  const scope = { entry: hex ? fromHex(hex) : null, federation: url.searchParams.get('federation') };
  const ask = askHex ? fromHex(askHex) : null;
  if (url.pathname === '/settle-ack') {
    const got = await seat.ack(rid, { txid: url.searchParams.get('txid'), ...scope });
    return got.ok ? new Response(got.bytes) : new Response(got.why, { status: 409 });
  }
  if (url.pathname === '/settle-commit') {
    const got = await seat.commit(rid, { txid: url.searchParams.get('txid'), acks: body, ...scope, door: true, ask });
    return got.ok ? new Response(encodeCommitments([got.commitment])) : new Response(got.why, { status: got.status || 409 });
  }
  if (url.pathname === '/settle-share') {
    const got = await seat.share(rid, decodeCommitments(body), { ...scope, door: true, ask });
    return got.ok ? new Response(encodeShare(got.share)) : new Response(got.why, { status: got.status || 409 });
  }
  if (url.pathname === '/settle-signature') {
    const got = await seat.take(rid, body, scope);
    return got.ok ? new Response('kept', { status: 201 }) : new Response(got.why, { status: 409 });
  }
  throw new Error(`no such door ${url.pathname}`);
}

const door = (k, path, extra = '') => new URL(`${base(k)}${path}?round=${toHex(RID)}${extra}`);
const signedOver = (w) => w.port.settled.map((x) => schnorr.verify(x.signature, MSG, DEAL.groupPublicKey.subarray(1)));

/** A STRANGER WHO RACES THE ASKER: it sees the list on its way to seat `to` and gets there first with a made-up one, the seat's own commitment and four invented ones. */
function racer(w, { signAs = null } = {}) {
  const tried = [];
  const invented = [0, 1, 2, 3].map((i) => ({ hiding: curve.pointFromScalar(BigInt(3000 + i)), binding: curve.pointFromScalar(BigInt(4000 + i)) }));
  return {
    tried,
    beforeShare: async (to, url, body) => {
      const real = decodeCommitments(body);
      const own = real.find((c) => String(c.id) === String(DEAL.shares[to].id));
      const others = DEAL.shares.map((s) => s.id).filter((id) => id !== own.id).slice(0, 4).map((id, i) => ({ id, ...invented[i] }));
      const made = encodeCommitments([own, ...others].sort((a, b) => a.id - b.id));
      const ask = signAs === null ? null : toHex(signSettlementAsk({ step: ASK_SHARE, roundId: RID, settlementTxid: MSG, payload: made }, schnorr.getPublicKey(signAs), signer(signAs)));
      const r = await serve(w.seats[to], url, made, ask);
      tried.push({ to, ok: r.ok, status: r.status, why: r.ok ? '' : await r.text() });
    },
  };
}

test('the height is named the way the others are: testnet4 not yet, regtest and devnet from 0, mainnet from genesis; read at the round\'s census height', () => {
  assert.equal(settlementAskPoint('testnet4'), null);
  assert.equal(settlementAskPoint('testnet'), null);
  assert.equal(settlementAskPoint('regtest'), 0);
  assert.equal(settlementAskPoint('devnet'), 0);
  assert.equal(settlementAskPoint('mainnet'), 0);
  const c = { protocolVersion: 22, networkId: NETWORK_ID_REGTEST, censusHeight: CENSUS, nodes: NODES };
  assert.equal(asksBySeat(c), true);
  assert.equal(asksBySeat(c, BELOW), false);
  assert.equal(asksBySeat({ ...c, censusHeight: CENSUS + 1 }, BELOW), true);
  assert.equal(asksBySeat({ ...c, protocolVersion: 20 }), false, 'a round with no acks keeps its doors as they were');
  assert.equal(asksBySeat({ ...c, networkId: new Uint8Array(32).fill(9) }), false);
});

test('below the height a stranger racing the asker spoils every pass: the share door signs its list and the real one is refused', async () => {
  const race = {};
  const w = seven({ askPointOf: BELOW, beforeShare: (...a) => race.beforeShare(...a) });
  const r = racer(w);
  race.beforeShare = r.beforeShare;
  const passes = [];
  for (let i = 0; i < 3; i++) {
    const got = await w.seats[0].settle(RID);
    passes.push(got.state || `refused: ${String(got.why).slice(0, 120)}`);
  }
  console.log(`  FACTS: below the height, three passes with a racing stranger: ${passes.join(' | ')}`);
  console.log(`  FACTS: the stranger's made-up lists signed ${r.tried.filter((x) => x.ok).length} of ${r.tried.length}; "keeps no second pair" ${w.refusals.filter((x) => /keeps no second pair/.test(x)).length} times`);
  assert.equal(w.port.settled.length, 0, 'a pass went through with the stranger racing it');
  assert.ok(r.tried.length > 0 && r.tried.every((x) => x.ok), 'the open door signed the stranger\'s lists');
  assert.ok(w.refusals.some((x) => /keeps no second pair/.test(x)));
});

test('at the height the same stranger is refused at the share door and the pass goes through, the first time', async () => {
  const race = {};
  const w = seven({ askPointOf: ABOVE, beforeShare: (...a) => race.beforeShare(...a) });
  const r = racer(w);
  race.beforeShare = r.beforeShare;
  const got = await w.seats[0].settle(RID);
  console.log(`  FACTS: at the height, one pass with a racing stranger: ${got.state || got.why}; the stranger's ${r.tried.length} lists: ${[...new Set(r.tried.map((x) => `${x.status} ${x.why}`))].join(' / ')}`);
  assert.equal(got.state, 'ACCEPTED', got.why);
  assert.deepEqual(signedOver(w), [true]);
  assert.ok(r.tried.length === 6 && r.tried.every((x) => !x.ok && x.status === 403), 'a stranger\'s list was answered');
  assert.equal(w.refusals.length, 0, w.refusals.join('; '));
});

test('a stranger that signs with its own key is no seat of the round, and is refused the same way', async () => {
  const race = {};
  const w = seven({ askPointOf: ABOVE, beforeShare: (...a) => race.beforeShare(...a) });
  const r = racer(w, { signAs: STRANGER });
  race.beforeShare = r.beforeShare;
  const got = await w.seats[0].settle(RID);
  assert.equal(got.state, 'ACCEPTED', got.why);
  assert.ok(r.tried.every((x) => x.status === 403 && /not one of the round's seats/.test(x.why)), r.tried.map((x) => x.why).join('; '));
});

test('the ack door stays open, and the acks a stranger collects there buy it no commitment at the height; below it they do', async () => {
  for (const [name, askPointOf, answered] of [['at the height', ABOVE, false], ['below it', BELOW, true]]) {
    const w = seven({ askPointOf });
    const acks = [];
    for (const k of [1, 2, 3, 4, 5]) {
      const r = await serve(w.seats[k], door(k, '/settle-ack', `&txid=${TXID}`), new Uint8Array());
      assert.equal(r.ok, true, 'the ack door answers anyone');
      acks.push(new Uint8Array(await r.arrayBuffer()));
    }
    const commit = await serve(w.seats[6], door(6, '/settle-commit', `&txid=${TXID}`), joinAcks(acks));
    const why = commit.ok ? 'a commitment' : `${commit.status} ${await commit.text()}`;
    console.log(`  FACTS: ${name}: a stranger with 5 acks from the open door at the commit door: ${why}`);
    assert.equal(commit.ok, answered, why);
    if (!answered) assert.equal(commit.status, 403);
  }
});

test('a seat\'s signed ask binds the body it was sent with: replayed over another list or another step it is refused', async () => {
  const w = seven({ askPointOf: ABOVE });
  const acks = [];
  for (const k of [0, 1, 2, 3, 4]) acks.push((await w.seats[k].ack(RID, { txid: TXID })).bytes);
  const body = joinAcks(acks);
  const commitAsk = signSettlementAsk({ step: ASK_COMMIT, roundId: RID, settlementTxid: MSG, payload: body }, NODES[0], signer(KEYS[0]));
  assert.equal(checkSettlementAsk(commitAsk, { seats: NODES, ask: { step: ASK_COMMIT, roundId: RID, settlementTxid: MSG, payload: body }, verify }).ok, true);
  const commits = [];
  for (const k of [1, 2, 3, 4, 5]) {
    const r = await serve(w.seats[k], door(k, '/settle-commit', `&txid=${TXID}`), body, toHex(commitAsk));
    assert.equal(r.ok, true, await r.clone().text());
    commits.push(decodeCommitments(new Uint8Array(await r.arrayBuffer()))[0]);
  }
  const own = (await w.seats[0].commit(RID, { txid: TXID, acks: body })).commitment;
  const list = encodeCommitments([own, ...commits.slice(0, 4)].sort((a, b) => a.id - b.id));
  const shareAsk = toHex(signSettlementAsk({ step: ASK_SHARE, roundId: RID, settlementTxid: MSG, payload: list }, NODES[0], signer(KEYS[0])));
  // THE COMMIT'S ASK AT THE SHARE DOOR, AND THE SHARE'S ASK OVER ANOTHER LIST
  const other = encodeCommitments([own, ...commits.slice(1, 5)].sort((a, b) => a.id - b.id));
  const wrongStep = await serve(w.seats[1], door(1, '/settle-share'), list, toHex(commitAsk));
  const wrongList = await serve(w.seats[5], door(5, '/settle-share'), other, shareAsk);
  assert.equal(wrongStep.status, 403);
  assert.match(await wrongStep.text(), /signed an ask for other bytes/);
  assert.equal(wrongList.status, 403);
  assert.match(await wrongList.text(), /signed an ask for other bytes/);
  // THE RIGHT ASK OVER THE RIGHT LIST: answered, and the pair the replays could not reach is still unspent
  const right = await serve(w.seats[1], door(1, '/settle-share'), list, shareAsk);
  assert.equal(right.ok, true, await right.clone().text());
  // A late settlement's ask names its entry: the round's own ask does not open it
  const late = await serve(w.seats[2], door(2, '/settle-commit', `&entry=${toHex(ENTRY)}&txid=${TXID}`), body, toHex(commitAsk));
  assert.equal(late.status, 403);
});

test('an honest round below the height is unchanged: no ask on the wire, one request per peer per step, the same signature', async () => {
  const below = [], above = [];
  const a = seven({ askPointOf: BELOW, wire: below });
  const b = seven({ askPointOf: ABOVE, wire: above });
  const ga = await a.seats[0].settle(RID);
  const gb = await b.seats[0].settle(RID);
  assert.equal(ga.state, 'ACCEPTED', ga.why);
  assert.equal(gb.state, 'ACCEPTED', gb.why);
  const steps = ['/settle-ack', '/settle-commit', '/settle-share', '/settle-signature'];
  for (const p of steps) {
    assert.equal(below.filter((x) => x.path === p).length, 6, `six peers asked at ${p} below the height`);
    assert.equal(above.filter((x) => x.path === p).length, 6, `six peers asked at ${p} at the height`);
  }
  assert.equal(below.filter((x) => x.ask).length, 0, 'an ask was sent below the height');
  assert.deepEqual(above.filter((x) => x.ask).map((x) => x.path).sort(), [...Array(6).fill('/settle-commit'), ...Array(6).fill('/settle-share')]);
  assert.equal(toHex(a.port.settled[0].signature), toHex(b.port.settled[0].signature), 'the same nonces sign the same bytes either way');
  console.log(`  FACTS: honest round, below the height: ${below.length} requests, ${below.filter((x) => x.ask).length} asks; at the height: ${above.length} requests, ${above.filter((x) => x.ask).length} asks (commit and share only); same signature`);
});

test('a late settlement asks under its own entry and settles at the height', async () => {
  const wire = [];
  const w = seven({ askPointOf: ABOVE, wire });
  const got = await w.seats[0].settleLate(RID, ENTRY);
  assert.equal(got.state, 'ACCEPTED', got.why);
  assert.deepEqual(signedOver(w), [true]);
  assert.equal(wire.filter((x) => x.path === '/settle-share' && x.ask).length, 6);
  assert.equal(w.refusals.length, 0, w.refusals.join('; '));
});

test('a seat\'s own commit and share are not asked through the door, and a door call with no ask is refused only at the height', async () => {
  const w = seven({ askPointOf: ABOVE });
  const acks = [];
  for (const k of [0, 1, 2, 3, 4]) acks.push((await w.seats[k].ack(RID, { txid: TXID })).bytes);
  assert.equal(splitAcks(joinAcks(acks)).length, 5);
  assert.equal((await w.seats[3].commit(RID, { txid: TXID, acks: joinAcks(acks) })).ok, true, 'a seat\'s own commit');
  const atDoor = await w.seats[3].commit(RID, { txid: TXID, acks: joinAcks(acks), door: true });
  assert.equal(atDoor.ok, false);
  assert.equal(atDoor.status, 403);
});
