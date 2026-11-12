// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2386, #2389 (wf1489-a45-refute-0-s3-4): THE FORFEIT'S COPY of the two holes WinningsSend closed in #2308 / #2322 and the settlement in
// #2386 - forfeit.js kept one shared cap of PAIRS_PER_FORFEIT pairs per forfeit (a door commit refused with 503 once full of pairs younger than
// holdMs) and spent a pair on the first list that carried its commitment, with /forfeit-commit and /forfeit-share open to anyone. So a stranger
// refilling each seat's cap kept every peer's commit refused, and one committee seat handed the asker's list re-posted it with its own commitment
// swapped: the honest seats signed that list and refused the asker's. Either way a qualifier's refund (an ENTRY_VOID lock, a cancelled order's
// locks) never formed. Seven real Forfeit instances with a real 5-of-7 FROST key, each seat a node key of the round's contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';

import { Forfeit, encodeCommitments, encodeShare } from '../src/forfeit.js';
import { decodeCommitments } from '../src/pool-wire.js';
import * as curve from '../src/curve.js';
import { evenGroupSecret } from '../../arena-protocol/src/frost-bip340.js';
import { trustedDealerSplit } from '../../arena-protocol/src/frost.js';
import { sha256, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { SEND_PLAN_ASK_HEADER, PLAN_ASK, sendPlanAskHeaders } from '../src/send-plan-ask.js';

// EACH SEAT'S NODE KEY, a seat of the round's contract: the asker signs its commit and share asks with it, as server.js hands the header on
const NODE_KEYS = [0, 1, 2, 3, 4, 5, 6].map((k) => { const secret = sha256(Uint8Array.from([0x60, k])); return { secret, pubkey: schnorr.getPublicKey(secret) }; });
const headerOf = (o) => (o && o.headers && o.headers[SEND_PLAN_ASK_HEADER]) || null;

const RID = new Uint8Array(32).fill(0x74);
const ENTRY = new Uint8Array(32).fill(0x75);
const MSG = new Uint8Array(32).fill(0xad);
const GROUP = evenGroupSecret(0x1074n, curve);
const DEAL = trustedDealerSplit({ secret: GROUP.secret, max: 7, min: 5, coefficients: [5n, 6n, 7n, 8n], curve });
const PUBLIC_SHARES = new Map(DEAL.shares.map((s) => [String(s.id), curve.pointFromScalar(s.share)]));
const BOUND_MS = 400;
const GRACE_MS = 100;

const base = (k) => `http://seat${k}`;
const seatOf = (u) => Number(new URL(u).hostname.slice(4));
// A FETCH TO A PROCESS THAT TOOK THE CONNECTION AND STOPPED: it never answers, and only the caller's signal ends it, as with fetch
const hang = (o) => new Promise((_, reject) => {
  if (o && o.signal) o.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
});

function stubRound(k) {
  const kept = new Map();
  return { identity: { secret: NODE_KEYS[k].secret }, pubkey: NODE_KEYS[k].pubkey, forfeit: (key) => kept.get(toHex(key)) || null, putForfeit: (r) => { kept.set(toHex(r.entryId), r); }, entryVoid: () => null, kept };
}

/**
 * The seven seats. `misbehave(k, path, o)` answers for seat k at that door, throws as a dropped connection, or hangs; undefined is the honest door.
 * `wire` logs every request as bytes.
 */
function seven({ misbehave = () => undefined, seed = 0x74, boundMs = BOUND_MS, wire = [] } = {}) {
  const seats = [];
  const refusals = [];
  for (let k = 0; k < 7; k++) {
    let drawn = 0;
    // A FIXED STREAM PER SEAT: the same nonces whichever order the peers are asked in, so the bytes on the wire can be compared
    const random = (n) => { const d = drawn++; return sha256(Uint8Array.from([seed, k, d & 255, (d >> 8) & 255, (d >> 16) & 255, n])); };
    const peers = [0, 1, 2, 3, 4, 5, 6].filter((j) => j !== k).map(base);
    const f = new Forfeit(stubRound(k), { curve, random, peersFor: () => peers, peerAskMs: boundMs, peerGraceMs: GRACE_MS,
      dkg: { publicSharesFor: () => ({ ok: true, shares: PUBLIC_SHARES }) },
      fetcher: async (u, o) => {
        const url = new URL(u);
        const to = seatOf(u);
        const body = o && o.body ? new Uint8Array(o.body) : new Uint8Array();
        wire.push(`${k} ${(o && o.method) || 'GET'} ${u} ${toHex(body)}`);
        const own = misbehave(to, url.pathname, o);
        if (own !== undefined) return own;
        const r = await serve(seats[to], url, body, headerOf(o));
        if (!r.ok) refusals.push(`${k}->${to} ${url.pathname}: ${await r.clone().text()}`);
        return r;
      } });
    const bytes = { ok: true, message: MSG, claimPk: DEAL.groupPublicKey, needed: 5, nodes: NODE_KEYS.map((x) => x.pubkey), signerNode: { id: DEAL.shares[k].id, share: DEAL.shares[k].share } };
    f.message = async () => bytes;
    seats.push(f);
  }
  return { seats, refusals, wire };
}

// WHAT server.js ANSWERS at /forfeit-commit, /forfeit-share and /forfeit-signature (the signed ask's header handed on, kanban #2386, #2389)
async function serve(seat, url, body, header = null) {
  const rid = fromHex(url.searchParams.get('round'));
  const eid = fromHex(url.searchParams.get('entry'));
  const kind = url.searchParams.get('lock') === 'fee' ? 'fee' : 'stake';
  if (url.pathname === '/forfeit-commit') {
    const got = await seat.commit(rid, eid, kind, { header, ask: url.searchParams.get('ask'), at: url.searchParams.get('at') });
    return got.ok ? new Response(encodeCommitments([got.commitment])) : new Response(got.why, { status: 409 });
  }
  if (url.pathname === '/forfeit-share') {
    const got = await seat.share(rid, eid, decodeCommitments(body), kind, { header });
    return got.ok ? new Response(encodeShare(got.share)) : new Response(got.why, { status: got.status || 409 });
  }
  if (url.pathname === '/forfeit-signature') {
    const got = await seat.take(rid, eid, body, kind);
    return got.ok ? new Response('forfeit kept', { status: 201 }) : new Response(got.why, { status: 409 });
  }
  throw new Error(`no such door ${url.pathname}`);
}

const verifies = (got) => !!(got && got.ok && schnorr.verify(got.signature, MSG, DEAL.groupPublicKey.subarray(1)));

/** The answer or, past `ms`, what it was doing: the measure works before the fix too, where the forfeit never answers. */
async function within(p, ms) {
  const t0 = Date.now();
  let timer;
  const out = await Promise.race([p.then((value) => ({ value }), (e) => ({ value: { ok: false, why: `threw: ${e.message}` } })),
    new Promise((ok) => { timer = setTimeout(() => ok({ stuck: true }), ms); })]);
  clearTimeout(timer);
  return { ...out, ms: Date.now() - t0 };
}



test('wf1489-a45-refute-0-s3-4: a stranger filling every seat\'s /forfeit-commit cap does not keep the forfeit from forming', async () => {
  const w = seven({ seed: 0x77 });
  let drawn = 0;
  for (const s of w.seats) for (let i = 0; i < 1000; i++) { const r = await s.commit(RID, ENTRY, 'stake'); if (!r.ok) break; drawn++; }
  const got = await within(w.seats[0].forfeit(RID, ENTRY), 8000);
  console.log(`  FACTS: stranger drew ${drawn} pairs; forfeit: ${got.stuck ? 'still waiting' : got.value.ok ? 'made' : got.value.why}`);
  assert.ok(!got.stuck && verifies(got.value), `a stranger's /forfeit-commit flood kept the forfeit unsigned: ${got.stuck ? 'stuck' : got.value.why}`);
});

const LAG_MS = 150;   // the asker is farther from the honest seats than the bad seat is
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BAD = 6;

test('wf1489-a45-refute-0-s3-4: one seat re-posting the asker\'s forfeit list with its own commitment swapped spends no honest pair', async () => {
  let w;
  let forged = 0;
  const q = `round=${toHex(RID)}&entry=${toHex(ENTRY)}`;
  w = seven({ seed: 0x78, misbehave: (to, path, o) => {
    if (path !== '/forfeit-share') return undefined;
    const body = new Uint8Array(o.body);
    const header = headerOf(o);
    if (to !== BAD) return (async () => { await sleep(LAG_MS); return serve(w.seats[to], new URL(`${base(to)}/forfeit-share?${q}`), body, header); })();
    return (async () => {
      const list = decodeCommitments(body);
      const id = String(DEAL.shares[BAD].id);
      const fake = list.map((c) => (String(c.id) === id ? { id: c.id, hiding: curve.pointFromScalar(BigInt(2000 + forged * 2 + 1)), binding: curve.pointFromScalar(BigInt(2000 + forged * 2 + 2)) } : c));
      const forgedBody = encodeCommitments(fake);
      // signed with the bad seat's own node key, a seat of the round
      const signed = PLAN_ASK.FORFEIT_SHARE ? sendPlanAskHeaders({ identity: { secret: NODE_KEYS[BAD].secret }, pubkey: NODE_KEYS[BAD].pubkey },
          { kind: PLAN_ASK.FORFEIT_SHARE, roundId: RID, lateEntryId: ENTRY, body: forgedBody })[SEND_PLAN_ASK_HEADER] : null;   // a build with no such kind: unsigned
      const r = await Promise.all([0, 1, 2, 3, 4, 5].map((k) => serve(w.seats[k], new URL(`${base(k)}/forfeit-share?${q}`), forgedBody, signed)));
      forged += r.filter((x) => x.ok).length;
      return serve(w.seats[BAD], new URL(`${base(BAD)}/forfeit-share?${q}`), body, header);   // and to the asker it answers as an honest seat
    })();
  } });
  const passes = [];
  let got = null;
  for (let i = 0; i < 4; i++) {
    got = await within(w.seats[i % 2].forfeit(RID, ENTRY), 8000);
    passes.push(got.stuck ? 'still waiting' : got.value.ok ? 'made' : String(got.value.why).slice(0, 100));
    if (!got.stuck && got.value.ok) break;
  }
  console.log(`  FACTS: the bad seat spent ${forged} honest pairs on its lists; passes: ${passes.join(' | ')}`);
  assert.equal(forged, 0, 'a seat\'s list spent pairs another asker drew');
  assert.ok(!got.stuck && verifies(got.value), `one seat kept the forfeit unsigned: ${passes.join(' | ')}`);
});

test('wf1489-a45-refute-0-s3-4 honest: unsigned asks (a seat on an older build) still form the forfeit', async () => {
  const w = seven({ seed: 0x79 });
  for (const s of w.seats) { s.round.identity = null; }
  const got = await within(w.seats[0].forfeit(RID, ENTRY), 8000);
  assert.ok(!got.stuck && verifies(got.value), got.stuck ? 'stuck' : got.value.why);
});
