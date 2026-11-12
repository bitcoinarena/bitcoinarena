// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2386, #2389 (wf1489-a45-refute-0-s3-3, ported to 2.0 - kanban #1489): A SETTLEMENT'S NONCE PAIR IS SPENT ONLY BY THE ASKER THAT DREW IT.
// 2.0's signed asks (#1075) let any seat of the round spend another asker's pair: one committee seat handed the asker's list re-posted it with its own
// commitment swapped, signed with its own node key, and the honest seats signed that list and refused the asker's ("keeps no second pair").
// The harness below is settlement-ask.test.js's (kanban #1075).
// (ORIGINAL HEADER) ONLY THE ROUND'S SEATS MAY ASK FOR A SETTLEMENT'S COMMIT OR SHARE (§5A.3, RULED 2026-11-03, kanban #1075). Since #1070 a list made up at the open share door costs a seat only the
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
  // AS THE TOOL ANSWERS (kanban #1171, #1172): an accepted submit's payouts stored and its claimed locks gone
  const port = { settled: [], settle: async (x) => { port.settled.push(x); return { accepted: true, payoutsStored: [{ stored: true }], locksAfter: [null] }; } };
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


test('#2386, #2389: a seat of the round re-posting the asker\'s list with its own commitment swapped, signed with its own key, spends no honest pair', async () => {
  const race = {};
  const w = seven({ askPointOf: ABOVE, beforeShare: (...a) => race.beforeShare(...a) });
  const r = racer(w, { signAs: KEYS[6] });
  race.beforeShare = r.beforeShare;
  const got = await w.seats[0].settle(RID);
  console.log(`  FACTS: a seat's signed made-up lists: ${[...new Set(r.tried.map((x) => `${x.status} ${x.why}`))].join(' / ')}; the pass: ${got.state || got.why}`);
  assert.equal(got.state, 'ACCEPTED', got.why);
  assert.deepEqual(signedOver(w), [true]);
  assert.ok(r.tried.length > 0 && r.tried.every((x) => !x.ok && x.status === 403 && /not signed by the asker/.test(x.why)), r.tried.map((x) => x.why).join('; '));
});

test('#2386, #2389 honest: with no racer the settlement forms on the first pass, every list spent by its own asker', async () => {
  const w = seven({ askPointOf: ABOVE });
  const got = await w.seats[0].settle(RID);
  assert.equal(got.state, 'ACCEPTED', got.why);
  assert.equal(w.refusals.length, 0, w.refusals.join('; '));
});
