// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489, #1910 wf1489-v1-refute-2-s2-3: THE WINNINGS SEND, as the forfeit (s2-1, s2-2). settle() and the winnings timer both reach sendAll for
// one round, so two signings of the same send by the same seat ran side by side. Since the #1667/#1731 slot per seat, both got the SAME pair at every
// peer (its signed ask while the pair is unspent), each with its own SELF commitment: each peer signed the first list and refused the other ("keeps no
// second pair"). Now a second signing of a send while one runs waits for that one's answer.
// (fixture from winnings-send-withheld-hung.test.js, with the seats' signed asks handed on as server.js does)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';

import { WinningsSend } from '../src/winnings-send.js';
import { encodeCommitments, decodeCommitments, encodeShare } from '../src/pool-wire.js';
import * as curve from '../src/curve.js';
import { evenGroupSecret } from '../../arena-protocol/src/frost-bip340.js';
import { trustedDealerSplit } from '../../arena-protocol/src/frost.js';
import { sha256, toHex, fromHex } from '../../arena-protocol/src/hash.js';

const RID = new Uint8Array(32).fill(0x86);
const ENTRY = new Uint8Array(32).fill(0x87);
const MSG = new Uint8Array(32).fill(0xbe);
const HASH = toHex(sha256(new Uint8Array(32).fill(0x88)));
const GROUP = evenGroupSecret(0x19100n, curve);
const DEAL = trustedDealerSplit({ secret: GROUP.secret, max: 7, min: 5, coefficients: [5n, 6n, 7n, 8n], curve });
const PUBLIC_SHARES = new Map(DEAL.shares.map((s) => [String(s.id), curve.pointFromScalar(s.share)]));
const SECRETS = [0, 1, 2, 3, 4, 5, 6].map((k) => sha256(Uint8Array.from([0x69, k])));
const NODES = SECRETS.map((s) => schnorr.getPublicKey(s));

const base = (k) => `http://seat${k}`;
const seatOf = (u) => Number(new URL(u).hostname.slice(4));

function stubRound(k) {
  const row = { entryId: ENTRY, roundId: RID, attempt: 0, address: 'w@example.com', invoice: 'lnbcrt1', paymentHash: HASH, invoiceMsat: 900n, payoutMsat: 1000n,
    owedMsat: 1000n, gatewayUrl: 'http://gw', gatewayPk: '02'.padEnd(66, '1'), expiration: 500n, state: 'SENDING', txid: 'ab'.repeat(32), donation: false };
  return { row, identity: { secret: SECRETS[k] }, pubkey: NODES[k], sendAttemptsOf: () => [row], sendPlansOf: () => [row], now: () => 0,
    markSend: () => {}, putWinnings: () => {}, putSendPlan: () => {} };
}

function seven() {
  const seats = [];
  const refusals = [];
  for (let k = 0; k < 7; k++) {
    let drawn = 0;
    const random = (n) => sha256(Uint8Array.from([0x86, k, drawn & 0xff, (drawn++ >> 8) & 0xff, n]));
    const peers = [0, 1, 2, 3, 4, 5, 6].filter((j) => j !== k).map(base);
    const s = new WinningsSend({ round: stubRound(k), port: null, curve, random, peersFor: () => peers, lnurlFetch: () => { throw new Error('no LNURL here'); },
      peerAskMs: 2000, peerGraceMs: 100, dkg: { publicSharesFor: () => ({ ok: true, shares: PUBLIC_SHARES }) },
      fetcher: async (u, o) => {
        const url = new URL(u);
        const to = seatOf(u);
        await new Promise((ok) => setTimeout(ok, 1 + ((k * 7 + to * 3 + drawn) % 5)));
        const body = o && o.body ? new Uint8Array(o.body) : new Uint8Array();
        const r = await serve(seats[to], url, body, (o && o.headers) || {});
        if (!r.ok) refusals.push(`${k}->${to} ${url.pathname}: ${await r.clone().text()}`);
        return r;
      } });
    s.messageFor = async () => MSG;
    s.built = { ok: true, claimPk: DEAL.groupPublicKey, needed: 5, contract: { nodes: NODES }, signerNode: { id: DEAL.shares[k].id, share: DEAL.shares[k].share } };
    seats.push(s);
  }
  return { seats, refusals };
}

// WHAT server.js ANSWERS at /send-commit and /send-share, the x-send-plan-ask header handed on
async function serve(seat, url, body, headers) {
  const rid = fromHex(url.searchParams.get('round'));
  const eHex = url.searchParams.get('entry');
  const kind = url.searchParams.get('kind') === 'resend' ? 'resend' : 'auth';
  const attempt = url.searchParams.has('attempt') ? Number(url.searchParams.get('attempt')) : null;
  const ask = headers['x-send-plan-ask'];
  if (url.pathname === '/send-commit') {
    const got = await seat.commit(rid, eHex, seat.built, kind, attempt, { hash: url.searchParams.get('hash'), ask });
    return got.ok ? new Response(encodeCommitments([got.commitment])) : new Response(got.why, { status: got.status || 409 });
  }
  if (url.pathname === '/send-share') {
    const got = await seat.share(rid, eHex, seat.built, decodeCommitments(body), kind, attempt, { ask });
    return got.ok ? new Response(encodeShare(got.share)) : new Response(got.why, { status: got.status || 409 });
  }
  throw new Error(`no such door ${url.pathname}`);
}

const verifies = (got) => !!(got && got.ok && schnorr.verify(got.signature, MSG, DEAL.groupPublicKey.subarray(1)));

test('#1910 refute s2-3: two signings of one send by one seat at once (settle() and the winnings timer) - both answer the auth, no peer refuses either', async () => {
  const w = seven();
  const s = w.seats[0];
  const got = await Promise.all([0, 1, 2, 3].map(() => s.sign(RID, s.round.row, s.built, 'auth').catch((e) => ({ ok: false, why: e.message }))));
  const second = w.refusals.filter((x) => /second pair/.test(x));
  console.log(`  FACTS: answers ${got.map((g) => (verifies(g) ? 'S' : 'R')).join('')}; "no second pair" refusals ${second.length}`);
  assert.deepEqual(got.map(verifies), [true, true, true, true], got.map((g) => g.why || 'ok').join(' | '));
  assert.equal(second.length, 0, `${second.length} shares refused because another signing of the same seat spent the pair`);
});
