// kanban #1489 wf1489-a45-refute-0-s1-1: the #1806 fix keeps at most 256 pairs per send message and drops the OLDEST. /send-commit answers anyone,
// so a stranger's 256 commits between an asker's commit and its share push out the asker's pair (the settlement's #1610 hole, fixed there, not
// here): every seat refuses the honest list ("does not carry this signer node's own commitment") and the winner's auth never forms.
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
    const random = (n) => { const d = drawn++; return sha256(Uint8Array.from([seed, k, d & 255, (d >> 8) & 255, (d >> 16) & 255, n])); };   // a counter that does not wrap at 256 draws
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

test('wf1489-a45-refute-0-s1-1: a stranger flooding /send-commit cannot push out the asker\'s pair before its share', async () => {
  let w;
  let flooded = 0;
  const eHex = toHex(ENTRY);
  const q = `round=${toHex(RID)}&entry=${eHex}&kind=auth&attempt=0&hash=${HASH}`;
  // THE ATTACKER: right after a seat answers an asker's /send-commit, it asks the same public door 256 more times (no share, no seat key)
  w = seven({ misbehave: (k, path) => {
    if (path !== '/send-commit') return undefined;
    return (async () => {
      const honest = await serve(w.seats[k], new URL(`${base(k)}/send-commit?${q}`), new Uint8Array());
      for (let i = 0; i < 256; i++) { const r = await serve(w.seats[k], new URL(`${base(k)}/send-commit?${q}`), new Uint8Array()); if (r.ok) flooded++; }
      return honest;
    })();
  } });
  const passes = [];
  let got = null;
  for (let i = 0; i < 4; i++) {
    const s = w.seats[i % 2];
    got = await s.sign(RID, s.round.row, s.built, 'auth').catch((e) => ({ ok: false, why: e.message }));
    passes.push(got.ok ? 'auth signed' : String(got.why).slice(0, 110));
    if (got.ok) break;
  }
  console.log(`  FACTS: stranger drew ${flooded} pairs; passes: ${passes.join(' | ')}`);
  assert.ok(verifies(got), `a stranger's commit flood kept the winner's send unsigned: ${passes.join(' | ')}`);
});

test('wf1489-a45-refute-0-s1-1 honest: with no attacker the auth signs', async () => {
  const w = seven();
  const s = w.seats[0];
  const got = await s.sign(RID, s.round.row, s.built, 'auth');
  assert.ok(verifies(got), JSON.stringify(got && got.why));
});
