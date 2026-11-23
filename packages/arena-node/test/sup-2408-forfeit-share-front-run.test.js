// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2408 (#1489 a44-refute-25-s2, a #1611 variant), adapted to 1.9 by #2536: A COMMITTEE PEER SPENDS THE HONEST SEATS' PAIRS FIRST.
// /forfeit-share answered anybody and a pair signed the first list that carried it. One dishonest seat on the list (seat 6), nearer to every
// honest seat than the asker is, reads the list from its own share request and at once sends each honest peer a list that differs in its own
// entry: each honest seat spent its pair on that list and refused the asker's, so the forfeit failed at every asker. The card's fix (a bind
// header and a spend token) did not reach 1.9; 1.9 has #2386/#2389 instead (asker-pairs.js: a pair is spent only on a list signed by the
// asker that drew it, PLAN_ASK.FORFEIT_SHARE over the list's bytes). The same front-run on 1.9's fixture (wf1489-a45-refute-0-s3-4: each
// seat a node key of the round's contract), sent both ways the bad seat can: with the asker's own header handed on, and signed with its
// own node key. Network: asker -> seat 6 and seat 6 -> others 5 ms, asker -> the other seats 40 ms.
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
function seven({ misbehave = () => undefined, seed = 0x74, boundMs = BOUND_MS, wire = [], delay = () => 0 } = {}) {
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
        { const ms = delay(k, to, url.pathname); if (ms) await new Promise((ok) => setTimeout(ok, ms)); }
        const own = await misbehave(to, url.pathname, o, body, url, k);
        if (own !== undefined) return own;
        const r = await serve(seats[to], url, body, headerOf(o));
        if (!r.ok) refusals.push(`${k}->${to} ${url.pathname}: ${await r.clone().text()}`);
        return r;
      } });
    const bytes = { ok: true, message: MSG, claimPk: DEAL.groupPublicKey, needed: 5, nodes: NODE_KEYS.map((x) => x.pubkey), signerNode: { id: DEAL.shares[k].id, share: DEAL.shares[k].share } };
    f.message = async () => bytes;
    seats.push(f);
  }
  return { seats, refusals, wire, serve: (to, url, body, header) => serve(seats[to], url, body, header) };
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



const BAD = 6;
function frontRunner(state) {
  return async (to, path, o, body, url, from) => {
    if (to !== BAD || path !== '/forfeit-share' || from === BAD) return undefined;
    const list = decodeCommitments(body);
    const fresh = await state.w.seats[BAD].commit(RID, ENTRY, 'stake', { own: true });
    const mineId = String(fresh.commitment.id);
    const other = list.map((c) => (String(c.id) === mineId ? fresh.commitment : c));
    const forged = encodeCommitments(other.sort((a, b) => a.id - b.id));
    const ownSigned = sendPlanAskHeaders({ identity: { secret: NODE_KEYS[BAD].secret }, pubkey: NODE_KEYS[BAD].pubkey },
      { kind: PLAN_ASK.FORFEIT_SHARE, roundId: RID, lateEntryId: ENTRY, body: forged })[SEND_PLAN_ASK_HEADER];
    const fired = [];
    await new Promise((ok) => setTimeout(ok, 5));      // seat 6 -> each honest seat: 5 ms
    for (const c of list) {
      if (String(c.id) === mineId) continue;
      const k = DEAL.shares.findIndex((s) => String(s.id) === String(c.id));
      if (k === from) continue;
      for (const [how, header] of [['asker header', headerOf(o)], ['own key', ownSigned], ['unsigned', null]]) {
        fired.push(state.w.serve(k, new URL(`${base(k)}/forfeit-share?${url.searchParams}`), forged, header)
          .then(async (r) => { state.spent.push(`${k}/${how}:${r.ok ? 'SIGNED' : (await r.text()).slice(0, 40)}`); if (r.ok) state.signed++; }));
      }
    }
    await Promise.all(fired);
    return undefined;                                    // and then it answers the asker honestly, with its own share
  };
}
const lag = (from, to, path) => (path !== '/forfeit-share' ? 0 : to === BAD || from === BAD ? 5 : 40);

test('#2408 (1.9): one committee peer that reads the share list cannot spend the honest seats\' pairs and hold the forfeit', async () => {
  const state = { spent: [], signed: 0 };
  state.w = seven({ seed: 0x7a, misbehave: frontRunner(state), delay: lag });
  const results = [];
  let made = null;
  for (const asker of [0, 1, 2]) {
    const got = await within(state.w.seats[asker].forfeit(RID, ENTRY), 20_000);
    const v = got.value || { ok: false, why: 'stuck' };
    results.push(`seat ${asker}: ${v.ok ? 'made' : String(v.why).slice(0, 120)}`);
    if (verifies(v)) { made = v; break; }
  }
  console.log(`  FACTS: front-runs ${state.spent.length}, forged lists signed ${state.signed} | ${results.join(' | ')}`);
  assert.equal(state.signed, 0, `honest seats signed the bad seat's lists: ${state.spent.filter((x) => x.includes('SIGNED')).join(', ')}`);
  assert.ok(made, `one dishonest seat of seven held the forfeit at three askers: ${results.join(' | ')}`);
});

test('#2408 (1.9): without the dishonest seat the same network makes the forfeit (control)', async () => {
  const w = seven({ seed: 0x7b, delay: lag });
  const got = await within(w.seats[0].forfeit(RID, ENTRY), 20_000);
  assert.ok(verifies(got.value), `control: ${got.value && got.value.why}`);
});
