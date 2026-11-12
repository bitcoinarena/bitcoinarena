// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { schnorr } from '@noble/curves/secp256k1.js';

import { LockSettlement, encodeCommitments, encodeShare, decodeCommitments } from '../src/settlement.js';
import { StakeSecrets } from '../src/stake-secret.js';
import { askPeers } from '../src/peer-ask.js';
import * as curve from '../src/curve.js';
import { evenGroupSecret } from '../../arena-protocol/src/frost-bip340.js';
import { trustedDealerSplit } from '../../arena-protocol/src/frost.js';
import { sha256, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { SEND_PLAN_ASK_HEADER, PLAN_ASK, sendPlanAskHeaders } from '../src/send-plan-ask.js';

// EACH SEAT'S NODE KEY, a seat of the round's contract (kanban #2386, #2389, as the send's #2308 test): the asker signs its commit and share
// asks with it, as server.js hands the header on; a stranger holds none of them
const NODE_KEYS = [0, 1, 2, 3, 4, 5, 6].map((k) => { const secret = sha256(Uint8Array.from([0x5f, k])); return { secret, pubkey: schnorr.getPublicKey(secret) }; });
const headerOf = (o) => (o && o.headers && o.headers[SEND_PLAN_ASK_HEADER]) || null;

const RID = new Uint8Array(32).fill(0x61);
const MSG = new Uint8Array(32).fill(0xab);
const TXID = toHex(MSG);
const GROUP = evenGroupSecret(0x1061n, curve);
const DEAL = trustedDealerSplit({ secret: GROUP.secret, max: 7, min: 5, coefficients: [5n, 6n, 7n, 8n], curve });
const BOUND_MS = 400;
const GRACE_MS = 100;

const CLOCK = { ms: 0 };
const base = (k) => `http://seat${k}`;
// A FETCH TO A PROCESS THAT TOOK THE CONNECTION AND STOPPED: it never answers, and only the caller's signal ends it, as with fetch
const hang = (o) => new Promise((_, reject) => {
  if (o && o.signal) o.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
});

function stubRound(k = 0) {
  const rows = { settlement: null };
  return {
    identity: { secret: NODE_KEYS[k].secret }, pubkey: NODE_KEYS[k].pubkey,
    get: () => null, lockSettlement: () => rows.settlement, putLockSettlement: (r) => { rows.settlement = r; }, putLockSettlementMoves: () => {},
    rows,
  };
}

/** The seven seats; `hungAt(k, path)` says seat k does not answer that path; `wire` logs what is sent, as bytes. */
function seven({ hungAt = () => false, wire = [], seed = 0x61, boundMs = BOUND_MS } = {}) {
  const now = () => CLOCK.ms;
  const seats = [];
  const port = { settled: [], settle: async (x) => { port.settled.push(x); return { accepted: true, payoutsStored: [{ id: 'payout-0' }], locksAfter: [null] }; } };   // as the tool answers (kanban #1171)
  for (let k = 0; k < 7; k++) {
    let drawn = 0;
    // A FIXED STREAM PER SEAT: the same nonces whichever order the peers are asked in, so the bytes on the wire can be compared
    const random = (n) => { const d = drawn++; return sha256(Uint8Array.from([seed, k, d & 0xff, (d >> 8) & 0xff, (d >> 16) & 0xff, n])); };   // a counter that does not wrap at 256 draws
    const round = stubRound(k);
    const peers = [0, 1, 2, 3, 4, 5, 6].filter((j) => j !== k).map(base);
    const s = new LockSettlement(round, { curve, random, port, peersFor: () => peers, peerAskMs: boundMs, peerReadMs: boundMs, peerGraceMs: GRACE_MS, now,
      fetcher: (u, o) => {
        const url = new URL(u);
        const to = Number(url.hostname.slice(4));
        const body = o && o.body ? new Uint8Array(o.body) : new Uint8Array();
        wire.push(`${k} ${(o && o.method) || 'GET'} ${u} ${toHex(body)}`);
        if (hungAt(to, url.pathname)) return hang(o);
        return serve(seats[to], url, body, headerOf(o));
      } });
    s.message = async () => ({ ok: true, txid: TXID, message: MSG, claimPk: DEAL.groupPublicKey, needed: 5, claims: [], contract: { nodes: NODE_KEYS.map((x) => x.pubkey) },
      plan: { payouts: [], claims: [], nonce: new Uint8Array(32), stakeShares: [] }, signerNode: { id: DEAL.shares[k].id, share: DEAL.shares[k].share } });
    seats.push(s);
  }
  return { seats, port, wire };
}

// WHAT server.js ANSWERS at /settle-commit, /settle-share and /settle-signature (the signed ask's header handed on, kanban #2386, #2389)
async function serve(seat, url, body, header = null) {
  const rid = fromHex(url.searchParams.get('round'));
  if (url.pathname === '/settle-commit') {
    const got = await seat.commit(rid, { txid: url.searchParams.get('txid'), header, ask: url.searchParams.get('ask'), at: url.searchParams.get('at') });
    return got.ok ? new Response(encodeCommitments([got.commitment])) : new Response(got.why, { status: 409 });
  }
  if (url.pathname === '/settle-share') {
    const got = await seat.share(rid, decodeCommitments(body), { header });
    return got.ok ? new Response(encodeShare(got.share)) : new Response(got.why, { status: 409 });
  }
  if (url.pathname === '/settle-signature') {
    const got = await seat.take(rid, body);
    return got.ok ? new Response('kept', { status: 201 }) : new Response(got.why, { status: 409 });
  }
  throw new Error(`no such door ${url.pathname}`);
}

/** The answer or, past `ms`, what it was doing: the measure works before the fix too, where the settlement never answers. */
async function within(p, ms) {
  const t0 = Date.now();
  let timer;
  const out = await Promise.race([p.then((value) => ({ value })), new Promise((ok) => { timer = setTimeout(() => ok({ stuck: true }), ms); })]);
  clearTimeout(timer);
  return { ...out, ms: Date.now() - t0 };
}
// kanban #1489 wf1489-a45-refute-0-s3-1 (skeptic 3 on #1806, lens: second copies). The #2308 fix to WinningsSend gave each asker its own
// bucket because ONE shared cap of pairs, refused with 503 once full of pairs younger than keptMs, let a stranger at the open door keep every
// commit refused. settlement.js #1610 is the same logic and was left as it was ("settlement.js #1610 has the same shared cap (not changed
// here)"): /settle-commit answers anyone, so a stranger who sends PAIRS_KEPT commits to every seat each keptMs (2*peerAskMs + peerGraceMs,
// 123 s live) keeps every seat's door full - the asker's own commit in settle() is refused first (there is no `own` bypass here) and the
// peers' ones too. No settlement forms, so no winner's send ever starts: the same effect #1806/#2308 ended for the send.
// Safe behaviour: a stranger's commits never refuse the commits of the round's own seats; the settlement forms.
test('wf1489-a45-refute-0-s3-1: a stranger refilling every seat\'s settle-commit cap each keptMs cannot keep the settlement from forming', async () => {
  CLOCK.ms = 0;
  const w = seven({ seed: 0x73 });
  const keptMs = 2 * BOUND_MS + GRACE_MS;
  let drawn = 0;
  // THE STRANGER: no seat key; before each pass it fills every seat's door (pairs older than keptMs go first, as #1610 allows)
  const flood = async () => { for (const s of w.seats) for (let i = 0; i < 1000; i++) { const r = await s.commit(RID, { txid: TXID }); if (!r.ok) break; drawn++; } };
  const passes = [];
  let got = null;
  for (let i = 0; i < 4; i++) {
    await flood();
    got = await within(w.seats[i % 2].settle(RID), 8000);
    passes.push(got.stuck ? 'still waiting' : `${got.value.state || ''} ${got.value.status || ''} ${String(got.value.why || '').slice(0, 90)}`);
    if (!got.stuck && got.value.state === 'ACCEPTED') break;
    CLOCK.ms += keptMs;   // the sweep asks again later; the stranger's requests per seat per keptMs keep up
  }
  console.log(`  FACTS: stranger drew ${drawn} pairs over ${passes.length} keptMs windows; passes: ${passes.join(' | ')}; submissions ${w.port.settled.length}`);
  assert.ok(!got.stuck && got.value.state === 'ACCEPTED', `a stranger's sustained /settle-commit flood kept the settlement unsigned: ${passes.join(' | ')}`);
});

test('wf1489-a45-refute-0-s3-1 honest: with no stranger the settlement forms', async () => {
  CLOCK.ms = 0;
  const w = seven({ seed: 0x74 });
  const got = await within(w.seats[0].settle(RID), 8000);
  assert.ok(!got.stuck && got.value.state === 'ACCEPTED', JSON.stringify(got.value && got.value.why));
});
