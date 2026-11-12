// kanban #1489 wf1489-r6-settle-1: the #1494 fix (a fresh nonce pair per commit, settlement.js and forfeit.js) never reached the winnings send.
// WinningsSend.commit hands the SAME unspent pair to every asker of POST /send-commit, and POST /send-share spends it on any list that carries it -
// both doors answer anyone. An outsider polling the two doors spends each seat's pair on a list of invented commitments between the asker's commit and
// its share, so the asker's list is refused ("keeps no second pair") at every seat and the winner's auth never forms: the winning is never sent.
// (fixture copied from winnings-send-withheld-hung.test.js)
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE WITHHELD SHARE OR ONE HUNG SEAT DOES NOT HOLD A WINNINGS SEND (kanban #1074, after #1070 and #1061 on the settlement). The committee's auth of a
// send (and a re-send's txid) is signed as the settlement was before 528920eaf: one nonce pair per message, one list per pair, every seat that commits on
// the list. And the peers were asked one at a time with no bound, so a seat that took the connection and stopped held the send up to undici's 300 s at
// each step; the address's LNURL endpoint had no bound either.
//
// Seven real WinningsSend instances with a real 5-of-7 FROST key: each seat's own commit, share and paid, reached through a fetcher that answers as
// server.js does at /send-commit, /send-share, /winnings-paid and /resend-sends, and misbehaves or hangs for the seats a test names. Only the message
// a seat rebuilds (the invoice's consensus hash, `messageFor`) is stubbed, not the signing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';

import { WinningsSend } from '../src/winnings-send.js';
import { encodeCommitments, decodeCommitments, encodeShare } from '../src/pool-wire.js';
import * as curve from '../src/curve.js';
import { evenGroupSecret } from '../../arena-protocol/src/frost-bip340.js';
import { trustedDealerSplit } from '../../arena-protocol/src/frost.js';
import { sha256, toHex, fromHex } from '../../arena-protocol/src/hash.js';

const RID = new Uint8Array(32).fill(0x76);
const ENTRY = new Uint8Array(32).fill(0x77);
const MSG = new Uint8Array(32).fill(0xae);
const PREIMAGE = new Uint8Array(32).fill(0x78);
const HASH = toHex(sha256(PREIMAGE));
const GROUP = evenGroupSecret(0x10740n, curve);
const DEAL = trustedDealerSplit({ secret: GROUP.secret, max: 7, min: 5, coefficients: [5n, 6n, 7n, 8n], curve });
const PUBLIC_SHARES = new Map(DEAL.shares.map((s) => [String(s.id), curve.pointFromScalar(s.share)]));
const BOUND_MS = 400;
const GRACE_MS = 100;

const base = (k) => `http://seat${k}`;
const seatOf = (u) => Number(new URL(u).hostname.slice(4));
const hang = (o) => new Promise((_, reject) => {
  if (o && o.signal) o.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
});

/** One send's row, as every seat keeps it after the plan was agreed. */
function stubRound() {
  const row = { entryId: ENTRY, roundId: RID, attempt: 0, address: 'w@example.com', invoice: 'lnbcrt1', paymentHash: HASH, invoiceMsat: 900n, payoutMsat: 1000n,
    owedMsat: 1000n, gatewayUrl: 'http://gw', gatewayPk: '02'.padEnd(66, '1'), expiration: 500n, state: 'SENDING', txid: 'ab'.repeat(32), donation: false };
  const r = { row, paid: [], sendAttemptsOf: () => [row], sendPlansOf: () => [row], now: () => 0,
    markSend: (x) => { if (x.state === 'PAID') r.paid.push(x); }, putWinnings: () => {}, putSendPlan: () => {} };
  return r;
}

/** The seven seats. `misbehave(k, path, o)` answers for seat k at that door, throws, or hangs; undefined is the honest door. */
function seven({ misbehave = () => undefined, seed = 0x76, boundMs = BOUND_MS, wire = [], lnurlFetch = () => { throw new Error('no LNURL here'); } } = {}) {
  const seats = [];
  const refusals = [];
  for (let k = 0; k < 7; k++) {
    let drawn = 0;
    const random = (n) => sha256(Uint8Array.from([seed, k, drawn++, n]));
    const peers = [0, 1, 2, 3, 4, 5, 6].filter((j) => j !== k).map(base);
    const s = new WinningsSend({ round: stubRound(), port: null, curve, random, peersFor: () => peers, lnurlFetch, peerAskMs: boundMs, peerGraceMs: GRACE_MS, lnurlMs: boundMs,
      dkg: { publicSharesFor: () => ({ ok: true, shares: PUBLIC_SHARES }) },
      fetcher: async (u, o) => {
        const url = new URL(u);
        const to = seatOf(u);
        const body = o && o.body ? (typeof o.body === 'string' ? new TextEncoder().encode(o.body) : new Uint8Array(o.body)) : new Uint8Array();
        wire.push(`${k} ${(o && o.method) || 'GET'} ${u} ${toHex(body)}`);
        const own = misbehave(to, url.pathname, o);
        if (own !== undefined) return own;
        const r = await serve(seats[to], url, body);
        if (!r.ok) refusals.push(`${k}->${to} ${url.pathname}: ${await r.clone().text()}`);
        return r;
      } });
    s.messageFor = async () => MSG;
    s.built = { ok: true, claimPk: DEAL.groupPublicKey, needed: 5, contract: { nodes: [] }, signerNode: { id: DEAL.shares[k].id, share: DEAL.shares[k].share } };
    seats.push(s);
  }
  return { seats, refusals, wire };
}

// WHAT server.js ANSWERS at /send-commit, /send-share, /winnings-paid and /resend-sends
async function serve(seat, url, body) {
  const rid = fromHex(url.searchParams.get('round'));
  const eHex = url.searchParams.get('entry');
  const kind = url.searchParams.get('kind') === 'resend' ? 'resend' : 'auth';
  const attempt = url.searchParams.has('attempt') ? Number(url.searchParams.get('attempt')) : null;
  if (url.pathname === '/winnings-paid') {
    const got = seat.paid(rid, eHex, body);
    return got.ok ? new Response('kept', { status: 201 }) : new Response(got.why, { status: 409 });
  }
  if (url.pathname === '/resend-sends') return new Response('taken', { status: 201 });
  if (url.pathname === '/send-commit') {
    const got = await seat.commit(rid, eHex, seat.built, kind, attempt, { hash: url.searchParams.get('hash') });
    return got.ok ? new Response(encodeCommitments([got.commitment])) : new Response(got.why, { status: 409 });
  }
  if (url.pathname === '/send-share') {
    const got = await seat.share(rid, eHex, seat.built, decodeCommitments(body), kind, attempt);
    return got.ok ? new Response(encodeShare(got.share)) : new Response(got.why, { status: got.status || 409 });
  }
  throw new Error(`no such door ${url.pathname}`);
}


const verifies = (got) => !!(got && got.ok && schnorr.verify(got.signature, MSG, DEAL.groupPublicKey.subarray(1)));

test('wf1489-r6-settle-1: an outsider who is no seat cannot stop a winner\'s send by spending each seat\'s auth nonce pair on a made-up list', async () => {
  let w;
  let pins = 0;
  const eHex = toHex(ENTRY);
  const invented = [0, 1, 2, 3].map((i) => ({ hiding: curve.pointFromScalar(BigInt(3000 + i)), binding: curve.pointFromScalar(BigInt(4000 + i)) }));
  const q = `round=${toHex(RID)}&entry=${eHex}&kind=auth&attempt=0&hash=${HASH}`;
  // THE ATTACKER: right after a seat answers an asker's /send-commit, it asks the same door (the same unspent pair comes back) and spends that
  // pair at /send-share with the seat's own commitment and four invented ones
  const pin = async (k) => {
    const c = await serve(w.seats[k], new URL(`${base(k)}/send-commit?${q}`), new Uint8Array());
    if (!c.ok) return;
    const own = decodeCommitments(new Uint8Array(await c.arrayBuffer()))[0];
    const others = DEAL.shares.map((s) => s.id).filter((id) => id !== own.id).slice(0, 4).map((id, i) => ({ id, ...invented[i] }));
    const r = await serve(w.seats[k], new URL(`${base(k)}/send-share?${q}`), encodeCommitments([own, ...others].sort((a, b) => a.id - b.id)));
    if (r.ok) pins++;
  };
  w = seven({ misbehave: (k, path) => {
    if (path !== '/send-commit') return undefined;
    return (async () => {
      const honest = await serve(w.seats[k], new URL(`${base(k)}/send-commit?${q}`), new Uint8Array());
      await pin(k);
      return honest;
    })();
  } });
  const passes = [];
  let got = null;
  for (let i = 0; i < 4; i++) {
    const s = w.seats[i % 2];
    got = await s.sign(RID, s.round.row, s.built, 'auth').catch((e) => ({ ok: false, why: e.message }));
    passes.push(got.ok ? 'auth signed' : String(got.why).slice(0, 100));
    if (got.ok) break;
  }
  console.log(`  FACTS: attacker spent ${pins} pairs; passes: ${passes.join(' | ')}`);
  assert.ok(verifies(got), `an outsider kept the winner's send unsigned: ${passes.join(' | ')}`);
});
