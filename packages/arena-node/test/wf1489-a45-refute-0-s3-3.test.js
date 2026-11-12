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
function seven({ hungAt = () => false, misbehave = () => undefined, wire = [], seed = 0x61, boundMs = BOUND_MS } = {}) {
  const seats = [];
  const port = { settled: [], settle: async (x) => { port.settled.push(x); return { accepted: true, payoutsStored: [{ id: 'payout-0' }], locksAfter: [null] }; } };   // as the tool answers (kanban #1171)
  for (let k = 0; k < 7; k++) {
    let drawn = 0;
    // A FIXED STREAM PER SEAT: the same nonces whichever order the peers are asked in, so the bytes on the wire can be compared
    const random = (n) => { const d = drawn++; return sha256(Uint8Array.from([seed, k, d & 0xff, (d >> 8) & 0xff, (d >> 16) & 0xff, n])); };   // a counter that does not wrap at 256 draws
    const round = stubRound(k);
    const peers = [0, 1, 2, 3, 4, 5, 6].filter((j) => j !== k).map(base);
    const s = new LockSettlement(round, { curve, random, port, peersFor: () => peers, peerAskMs: boundMs, peerReadMs: boundMs, peerGraceMs: GRACE_MS,
      fetcher: (u, o) => {
        const url = new URL(u);
        const to = Number(url.hostname.slice(4));
        const body = o && o.body ? new Uint8Array(o.body) : new Uint8Array();
        wire.push(`${k} ${(o && o.method) || 'GET'} ${u} ${toHex(body)}`);
        if (hungAt(to, url.pathname)) return hang(o);
        { const own = misbehave(to, url.pathname, body, headerOf(o)); if (own !== undefined) return own; }
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
// kanban #1489 wf1489-a45-refute-0-s3-3 (skeptic 3 on #1806, lens: second copies). #2322 closed for WinningsSend: "one committee seat handed
// the asker's list re-posted it to every other seat with only its own commitment swapped; the honest seats signed that list and refused the
// asker's ('keeps no second pair'), #leaveOut dropped below the threshold: 1 of 7 seats stopped the send for good". settlement.js share() is
// the same code - a pair spent on the first list that carries its commitment, /settle-share unsigned - and was not changed. One seat of the
// committee that is handed the asker's settlement list stops the round's settlement, and with it every winner's send.
// Safe behaviour: a seat's list spends no pair another asker drew; the settlement forms with 6 honest seats of 7 (threshold 5).
const LAG_MS = 150;   // the asker is farther from the honest seats than the bad seat is
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BAD = 6;

function committee({ attack }) {
  let w;
  let forged = 0;
  const q = `round=${toHex(RID)}&txid=${TXID}`;
  w = seven({ seed: 0x75, misbehave: (to, path, body, header) => {
    if (path !== '/settle-share') return undefined;
    if (to !== BAD) return (async () => { await sleep(LAG_MS); return serve(w.seats[to], new URL(`${base(to)}/settle-share?${q}`), body, header); })();
    return (async () => {
      if (attack) {
        const list = decodeCommitments(body);
        const id = String(DEAL.shares[BAD].id);
        const fake = list.map((c) => (String(c.id) === id ? { id: c.id, hiding: curve.pointFromScalar(BigInt(1000 + forged * 2 + 1)), binding: curve.pointFromScalar(BigInt(1000 + forged * 2 + 2)) } : c));
        const forgedBody = encodeCommitments(fake);
        // THE BAD SEAT SIGNS ITS LIST WITH ITS OWN NODE KEY - a seat of the round (kanban #2386, #2389); unsigned, it would spend nothing either
        const signed = PLAN_ASK.SETTLE_SHARE ? sendPlanAskHeaders({ identity: { secret: NODE_KEYS[BAD].secret }, pubkey: NODE_KEYS[BAD].pubkey },
          { kind: PLAN_ASK.SETTLE_SHARE, roundId: RID, body: forgedBody })[SEND_PLAN_ASK_HEADER] : null;   // a build with no such kind: unsigned
        const r = await Promise.all([0, 1, 2, 3, 4, 5].map((k) => serve(w.seats[k], new URL(`${base(k)}/settle-share?${q}`), forgedBody, signed)));
        forged += r.filter((x) => x.ok).length;
      }
      return serve(w.seats[BAD], new URL(`${base(BAD)}/settle-share?${q}`), body, header);   // and to the asker it answers as an honest seat
    })();
  } });
  return { w, forged: () => forged };
}

test('wf1489-a45-refute-0-s3-3: one seat re-posting the asker\'s settlement list with its own commitment swapped cannot stop the settlement', async () => {
  const { w, forged } = committee({ attack: true });
  const passes = [];
  let got = null;
  for (let i = 0; i < 4; i++) {
    got = await within(w.seats[i % 2].settle(RID), 8000);
    passes.push(got.stuck ? 'still waiting' : `${got.value.state || ''} ${String(got.value.why || '').slice(0, 100)}`);
    if (!got.stuck && got.value.state === 'ACCEPTED') break;
  }
  console.log(`  FACTS: the bad seat spent ${forged()} honest pairs on its lists; passes: ${passes.join(' | ')}; submissions ${w.port.settled.length}`);
  assert.ok(!got.stuck && got.value.state === 'ACCEPTED', `one seat kept the settlement unsigned: ${passes.join(' | ')}`);
});

test('wf1489-a45-refute-0-s3-3 honest: the same lag, the seat honest, the settlement forms', async () => {
  const { w } = committee({ attack: false });
  const got = await within(w.seats[0].settle(RID), 8000);
  assert.ok(!got.stuck && got.value.state === 'ACCEPTED', JSON.stringify(got.value && got.value.why));
});
