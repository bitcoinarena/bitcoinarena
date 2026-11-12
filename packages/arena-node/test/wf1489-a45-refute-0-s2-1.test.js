// kanban #1489 wf1489-a45-refute-0-s2-1: the #2237 fix (refuting #1806) no longer pushes out a held pair; past 256 pairs handed out in the last
// keptMs (2*peerAskMs + peerGraceMs, 123 s live) it REFUSES every new commit with 503 - the asker's own commit too. /send-commit answers anyone,
// so a stranger who asks each seat's door 256 times per keptMs (about 2 requests a second per seat, public round, entry and hash) keeps every
// commit of the send refused at every seat: the asker's own commit fails first, its sign pass returns, and every retry finds the door full.
// The winner's auth never forms while the flood lasts - the same effect #1806 was to end, by refusal instead of by eviction.
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

const CLOCK = { ms: 0 };
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
  const r = { row, paid: [], sendAttemptsOf: () => [row], sendPlansOf: () => [row], now: () => CLOCK.ms,
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

test('wf1489-a45-refute-0-s2-1: a stranger refilling every seat\'s 256 pairs each keptMs cannot keep the winner\'s send from signing', async () => {
  const w = seven();
  const eHex = toHex(ENTRY);
  const q = `round=${toHex(RID)}&entry=${eHex}&kind=auth&attempt=0&hash=${HASH}`;
  const keptMs = 2 * BOUND_MS + GRACE_MS;
  let drawn = 0;
  // THE STRANGER: no seat key, no share; before each of the asker's passes it fills every seat's door (pairs older than keptMs go first, as the fix allows)
  const flood = async () => { for (let k = 0; k < 7; k++) for (let i = 0; i < 256; i++) { const r = await serve(w.seats[k], new URL(`${base(k)}/send-commit?${q}`), new Uint8Array()); if (r.ok) drawn++; } };
  const passes = [];
  let got = null;
  for (let i = 0; i < 6; i++) {
    await flood();
    const s = w.seats[i % 2];
    got = await s.sign(RID, s.round.row, s.built, 'auth').catch((e) => ({ ok: false, why: e.message }));
    passes.push(got.ok ? 'auth signed' : `${got.status || ''} ${String(got.why).slice(0, 90)}`);
    if (got.ok) break;
    CLOCK.ms += keptMs;   // the sweep asks again later; the stranger's 256 requests per seat per keptMs keep up
  }
  console.log(`  FACTS: stranger drew ${drawn} pairs over ${passes.length} keptMs windows; passes: ${passes.join(' | ')}`);
  assert.ok(verifies(got), `a stranger's sustained commit flood kept the winner's send unsigned: ${passes.join(' | ')}`);
});

test('wf1489-a45-refute-0-s2-1 honest: with no attacker the auth signs', async () => {
  CLOCK.ms = 0;
  const w = seven({ seed: 0x55 });
  const s = w.seats[0];
  const got = await s.sign(RID, s.round.row, s.built, 'auth');
  assert.ok(verifies(got), JSON.stringify(got && got.why));
});
