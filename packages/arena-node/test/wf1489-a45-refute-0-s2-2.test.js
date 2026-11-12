// kanban #1489 wf1489-a45-refute-0-s2-2: ONE SEAT, not a stranger. The #1806 / #2237 fix spends a seat's pair on the first list that carries
// its commitment, and /send-share answers anyone. A seat of the committee is handed the asker's whole list at its /send-share - every other
// seat's commitment - and at once posts each other seat a list of the same commitments with only its own swapped for a made-up one. Each
// honest seat spends its pair on that list, and the asker's list, arriving a moment later, is refused at every honest seat ("signed that auth
// over another list, and keeps no second pair"). The asker leaves the five out, fewer than 5 remain, the pass ends; every retry is the same.
// One of seven seats (threshold 5) stops the winner's send for good - a share costs it nothing, it answers the asker honestly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';

import { WinningsSend } from '../src/winnings-send.js';
import { encodeCommitments, decodeCommitments, encodeShare } from '../src/pool-wire.js';
import * as curve from '../src/curve.js';
import { evenGroupSecret } from '../../arena-protocol/src/frost-bip340.js';
import { trustedDealerSplit } from '../../arena-protocol/src/frost.js';
import { sha256, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { SEND_PLAN_ASK_HEADER, PLAN_ASK, sendPlanAskHeaders } from '../src/send-plan-ask.js';

// EACH SEAT'S NODE KEY, a seat of the round's contract (kanban #2308, #2322): the asker signs its commit and share asks with it, as server.js
// hands the header on; a stranger holds none of them
const NODE_KEYS = [0, 1, 2, 3, 4, 5, 6].map((k) => { const secret = sha256(Uint8Array.from([0x5e, k])); return { secret, pubkey: schnorr.getPublicKey(secret) }; });
const headerOf = (o) => (o && o.headers && o.headers[SEND_PLAN_ASK_HEADER]) || null;

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
function stubRound(k = 0) {
  const row = { entryId: ENTRY, roundId: RID, attempt: 0, address: 'w@example.com', invoice: 'lnbcrt1', paymentHash: HASH, invoiceMsat: 900n, payoutMsat: 1000n,
    owedMsat: 1000n, gatewayUrl: 'http://gw', gatewayPk: '02'.padEnd(66, '1'), expiration: 500n, state: 'SENDING', txid: 'ab'.repeat(32), donation: false };
  const r = { row, paid: [], sendAttemptsOf: () => [row], sendPlansOf: () => [row], now: () => 0,
    markSend: (x) => { if (x.state === 'PAID') r.paid.push(x); }, putWinnings: () => {}, putSendPlan: () => {},
    identity: { secret: NODE_KEYS[k].secret }, pubkey: NODE_KEYS[k].pubkey };
  return r;
}

/** The seven seats. `misbehave(k, path, o)` answers for seat k at that door, throws, or hangs; undefined is the honest door. */
function seven({ misbehave = () => undefined, seed = 0x76, boundMs = BOUND_MS, wire = [], lnurlFetch = () => { throw new Error('no LNURL here'); } } = {}) {
  const seats = [];
  const refusals = [];
  for (let k = 0; k < 7; k++) {
    let drawn = 0;
    const random = (n) => { const d = drawn++; return sha256(Uint8Array.from([seed, k, d & 255, (d >> 8) & 255, (d >> 16) & 255, n])); };   // a counter that does not wrap at 256 draws
    const peers = [0, 1, 2, 3, 4, 5, 6].filter((j) => j !== k).map(base);
    const s = new WinningsSend({ round: stubRound(k), port: null, curve, random, peersFor: () => peers, lnurlFetch, peerAskMs: boundMs, peerGraceMs: GRACE_MS, lnurlMs: boundMs,
      dkg: { publicSharesFor: () => ({ ok: true, shares: PUBLIC_SHARES }) },
      fetcher: async (u, o) => {
        const url = new URL(u);
        const to = seatOf(u);
        const body = o && o.body ? (typeof o.body === 'string' ? new TextEncoder().encode(o.body) : new Uint8Array(o.body)) : new Uint8Array();
        wire.push(`${k} ${(o && o.method) || 'GET'} ${u} ${toHex(body)}`);
        const own = misbehave(to, url.pathname, o);
        if (own !== undefined) return own;
        const r = await serve(seats[to], url, body, headerOf(o));
        if (!r.ok) refusals.push(`${k}->${to} ${url.pathname}: ${await r.clone().text()}`);
        return r;
      } });
    s.messageFor = async () => MSG;
    s.built = { ok: true, claimPk: DEAL.groupPublicKey, needed: 5, contract: { nodes: NODE_KEYS.map((x) => x.pubkey) }, signerNode: { id: DEAL.shares[k].id, share: DEAL.shares[k].share } };
    seats.push(s);
  }
  return { seats, refusals, wire };
}

// WHAT server.js ANSWERS at /send-commit, /send-share, /winnings-paid and /resend-sends
async function serve(seat, url, body, header = null) {
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
    const got = await seat.commit(rid, eHex, seat.built, kind, attempt, { hash: url.searchParams.get('hash'), header, ask: url.searchParams.get('ask'), at: url.searchParams.get('at') });
    return got.ok ? new Response(encodeCommitments([got.commitment])) : new Response(got.why, { status: 409 });
  }
  if (url.pathname === '/send-share') {
    const got = await seat.share(rid, eHex, seat.built, decodeCommitments(body), kind, attempt, { header });
    return got.ok ? new Response(encodeShare(got.share)) : new Response(got.why, { status: got.status || 409 });
  }
  throw new Error(`no such door ${url.pathname}`);
}


const verifies = (got) => !!(got && got.ok && schnorr.verify(got.signature, MSG, DEAL.groupPublicKey.subarray(1)));

const LAG_MS = 150;   // the asker is farther from the honest seats than the bad seat is (a seat near the others, the asker abroad)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BAD = 6;
const q = `round=${toHex(RID)}&entry=${toHex(ENTRY)}&kind=auth&attempt=0&hash=${HASH}`;

function committee({ attack }) {
  let w;
  let forged = 0;
  w = seven({ misbehave: (to, path, o) => {
    if (path !== '/send-share') return undefined;
    const body = new Uint8Array(o.body);
    if (to !== BAD) return (async () => { await sleep(LAG_MS); return serve(w.seats[to], new URL(`${base(to)}/send-share?${q}`), body, headerOf(o)); })();
    return (async () => {
      if (attack) {
        // THE BAD SEAT: the asker's list, its own commitment swapped for points of its own making, posted to every other seat at once
        const list = decodeCommitments(body);
        const id = String(DEAL.shares[BAD].id);
        const fake = list.map((c) => (String(c.id) === id ? { id: c.id, hiding: curve.pointFromScalar(BigInt(1000 + forged * 2 + 1)), binding: curve.pointFromScalar(BigInt(1000 + forged * 2 + 2)) } : c));
        const forgedBody = encodeCommitments(fake);
        // signed with the bad seat's own node key, a seat of the round (it holds no other seat's key)
        const signed = headerOf({ headers: sendPlanAskHeaders({ identity: { secret: NODE_KEYS[BAD].secret }, pubkey: NODE_KEYS[BAD].pubkey }, { kind: PLAN_ASK.SHARE, roundId: RID, body: forgedBody }) });
        const r = await Promise.all([0, 1, 2, 3, 4, 5].map((k) => serve(w.seats[k], new URL(`${base(k)}/send-share?${q}`), forgedBody, signed)));
        forged += r.filter((x) => x.ok).length;
      }
      return serve(w.seats[BAD], new URL(`${base(BAD)}/send-share?${q}`), body, headerOf(o));   // and to the asker it answers as an honest seat
    })();
  } });
  return { w, forged: () => forged };
}

test('wf1489-a45-refute-0-s2-2: one seat re-posting the asker\'s list with its own commitment swapped cannot stop the winner\'s send', async () => {
  const { w, forged } = committee({ attack: true });
  const passes = [];
  let got = null;
  for (let i = 0; i < 4; i++) {
    const s = w.seats[i % 2];
    got = await s.sign(RID, s.round.row, s.built, 'auth').catch((e) => ({ ok: false, why: e.message }));
    passes.push(got.ok ? 'auth signed' : String(got.why).slice(0, 110));
    if (got.ok) break;
  }
  console.log(`  FACTS: the bad seat spent ${forged()} honest pairs on its lists; passes: ${passes.join(' | ')}`);
  assert.ok(verifies(got), `one seat kept the winner's send unsigned: ${passes.join(' | ')}`);
});

test('wf1489-a45-refute-0-s2-2 honest: the same lag, the seat honest, the auth signs', async () => {
  const { w } = committee({ attack: false });
  const s = w.seats[0];
  const got = await s.sign(RID, s.round.row, s.built, 'auth');
  assert.ok(verifies(got), JSON.stringify(got && got.why));
});
