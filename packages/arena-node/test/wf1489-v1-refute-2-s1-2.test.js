// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 wf1489-v1-refute-2-2: the settle-1 pin (a stranger takes the unspent pair at the commit door and spends it on an invented list) at the second copy, /send-commit + /send-share. (fixture from winnings-send-withheld-hung.test.js)
//
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

const refused = () => new Response('this seat gives no share', { status: 503 });
const verifies = (got) => !!(got && got.ok && schnorr.verify(got.signature, MSG, DEAL.groupPublicKey.subarray(1)));
const sign = (w, k) => w.seats[k].sign(RID, w.seats[k].round.row, w.seats[k].built, 'auth');

async function within(p, ms) {
  const t0 = Date.now();
  let timer;
  const out = await Promise.race([p.then((value) => ({ value }), (e) => ({ value: { ok: false, why: `threw: ${e.message}` } })),
    new Promise((ok) => { timer = setTimeout(() => ok({ stuck: true }), ms); })]);
  clearTimeout(timer);
  return { ...out, ms: Date.now() - t0 };
}

test('#1489 refute: a stranger who is no seat pins every seat\'s send-auth nonce pair through /send-commit + /send-share, and the winning is never signed', async () => {
  let w;
  let pins = 0;
  const invented = [0, 1, 2, 3].map((i) => ({ hiding: curve.pointFromScalar(BigInt(3000 + i)), binding: curve.pointFromScalar(BigInt(4000 + i)) }));
  const pin = async (k, url) => {
    const c = await serve(w.seats[k], url, new Uint8Array());
    if (!c.ok) return;
    const own = decodeCommitments(new Uint8Array(await c.arrayBuffer()))[0];
    const others = DEAL.shares.map((s) => s.id).filter((id) => id !== own.id).slice(0, 4).map((id, i) => ({ id, ...invented[i] }));
    const su = new URL(url); su.pathname = '/send-share';
    const r = await serve(w.seats[k], su, encodeCommitments([own, ...others].sort((a, b) => a.id - b.id)));
    if (r.ok) pins++;
  };
  w = seven({ misbehave: (k, path, o) => undefined });
  // wrap each seat's fetcher: right after a seat answers /send-commit to an asker, the stranger asks it too and spends what it gets
  const orig = w.seats.map((s) => s.fetcher);
  w.seats.forEach((s, i) => { s.fetcher = async (u, o) => {
    const url = new URL(u);
    const r = await orig[i](u, o);
    if (url.pathname === '/send-commit') await pin(seatOf(u), url);
    return r;
  }; });
  const asks = [];
  let got = null;
  for (const asker of [0, 1, 0, 1]) {
    got = await sign(w, asker).catch((e) => ({ ok: false, why: e.message }));
    asks.push(`seat ${asker}: ${got.ok ? 'auth signed' : got.why}`);
    if (got.ok) break;
  }
  console.log(`  FACTS: stranger pinned ${pins} pairs; ${asks.join(' | ')}`);
  assert.ok(verifies(got), `a stranger kept the winning unsigned: ${asks.join(' | ')}`);
});
