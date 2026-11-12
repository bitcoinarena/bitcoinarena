// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-27 skeptic 3: SKEPTIC 1'S EVICTION AT THE SECOND COPY - THE SETTLEMENT. 897c910a7 fixed the forfeit's "oldest pair
// dropped first" (a stranger asking 257 commits between an honest commit and its share pushed the honest pair out), but settlement.js commit keeps
// the same rule with PAIRS_KEPT = 64: POST /settle-commit answers anybody, so 65 commits from a stranger right before the honest /settle-share
// reaches a seat drop the honest pair, and the asker's list is refused ("does not carry this signer node's own commitment") at every seat he
// reached. The round's losers' locks are never settled while he keeps doing it.
// Safe behaviour: the honest seats still settle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';

import { LockSettlement, encodeCommitments, encodeShare, decodeCommitments, PAIRS_KEPT } from '../src/settlement.js';
import * as curve from '../src/curve.js';
import { evenGroupSecret } from '../../arena-protocol/src/frost-bip340.js';
import { trustedDealerSplit } from '../../arena-protocol/src/frost.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { sha256, toHex, fromHex } from '../../arena-protocol/src/hash.js';

const RID = new Uint8Array(32).fill(0x70);
const MSG = new Uint8Array(32).fill(0xac);
const TXID = toHex(MSG);
const ENTRY = new Uint8Array(32).fill(0x71);
const FED = 'fe'.repeat(32);
const GROUP = evenGroupSecret(0x1070n, curve);
const DEAL = trustedDealerSplit({ secret: GROUP.secret, max: 7, min: 5, coefficients: [5n, 6n, 7n, 8n], curve });
const PUBLIC_SHARES = new Map(DEAL.shares.map((s) => [String(s.id), curve.pointFromScalar(s.share)]));

const base = (k) => `http://seat${k}`;
const seatOf = (u) => Number(new URL(u).hostname.slice(4));

/** What a stub round keeps, enough for a settlement, a late settlement and one federation's. */
function stubRound() {
  const rows = { settlement: null, late: null, fed: null };
  return {
    get: () => null, lockSettlement: () => rows.settlement, putLockSettlement: (r) => { rows.settlement = r; }, putLockSettlementMoves: () => {},
    lateLockSettlement: () => rows.late, putLateLockSettlement: (r) => { rows.late = r; },
    fedLockSettlement: () => rows.fed, putFedLockSettlement: (r) => { rows.fed = r; },
    rows,
  };
}

/** The seven seats. `misbehave(k, path, url)` answers for seat k at that door or throws as a dropped connection; undefined is the honest door. */
function seven({ misbehave = () => undefined, seed = 0x70 } = {}) {
  const seats = [];
  const port = { settled: [], settle: async (x) => { port.settled.push(x); return { accepted: true, payoutsStored: [{ id: 'payout-0' }], locksAfter: [null] }; } };   // as the tool answers (kanban #1171)
  const refusals = [];
  for (let k = 0; k < 7; k++) {
    let drawn = 0;
    const random = (n) => { const d = drawn++; return sha256(Uint8Array.from([seed, k, d & 255, n, (d >> 8) & 255, (d >> 16) & 255])); };
    const round = stubRound();
    const peers = [0, 1, 2, 3, 4, 5, 6].filter((j) => j !== k).map(base);
    const s = new LockSettlement(round, { curve, random, port, peersFor: () => peers, dkg: { publicSharesFor: () => ({ ok: true, shares: PUBLIC_SHARES }) },
      fetcher: async (u, o) => {
        const url = new URL(u);
        const to = seatOf(u);
        const own = misbehave(to, url.pathname, url);
        if (own !== undefined) return own;
        const r = await serve(seats[to], url, o && o.body ? new Uint8Array(o.body) : new Uint8Array());
        if (!r.ok) refusals.push(`${k}->${to} ${url.pathname}: ${await r.clone().text()}`);
        return r;
      } });
    const bytes = { ok: true, txid: TXID, message: MSG, claimPk: DEAL.groupPublicKey, needed: 5, claims: [], contract: { nodes: [] },
      plan: { payouts: [], claims: [], nonce: new Uint8Array(32), stakeShares: [] }, signerNode: { id: DEAL.shares[k].id, share: DEAL.shares[k].share } };
    s.message = async () => bytes;
    s.lateMessage = async () => bytes;
    s.fedMessage = async () => bytes;
    s.turn = async () => ({ mine: true, place: k });
    seats.push(s);
  }
  return { seats, port, refusals };
}

// WHAT server.js ANSWERS at /settle-commit, /settle-share and /settle-signature
async function serve(seat, url, body) {
  const rid = fromHex(url.searchParams.get('round'));
  const hex = url.searchParams.get('entry');
  const scope = { entry: hex ? fromHex(hex) : null, federation: url.searchParams.get('federation') };
  if (url.pathname === '/settle-commit') {
    const got = await seat.commit(rid, { txid: url.searchParams.get('txid'), ...scope });
    return got.ok ? new Response(encodeCommitments([got.commitment])) : new Response(got.why, { status: 409 });
  }
  if (url.pathname === '/settle-share') {
    const got = await seat.share(rid, decodeCommitments(body), scope);
    return got.ok ? new Response(encodeShare(got.share)) : new Response(got.why, { status: got.status || 409 });
  }
  if (url.pathname === '/settle-signature') {
    const got = await seat.take(rid, body, scope);
    return got.ok ? new Response('kept', { status: 201 }) : new Response(got.why, { status: 409 });
  }
  throw new Error(`no such door ${url.pathname}`);
}

const refused = () => new Response('this seat gives no share', { status: 503 });
const signedOver = (w) => w.port.settled.map((x) => schnorr.verify(x.signature, MSG, DEAL.groupPublicKey.subarray(1)));


test('a stranger who asks each seat for PAIRS_KEPT + 1 commitments before the honest share does not stop the settlement', async () => {
  const w = seven();
  let flooded = 0;
  for (const s of w.seats) {
    const orig = s.fetcher;
    s.fetcher = async (u, o) => {
      const url = new URL(u);
      if (url.pathname === '/settle-share') {
        const seat = w.seats[seatOf(u)];
        for (let i = 0; i <= PAIRS_KEPT; i++) {
          const r = await serve(seat, new URL(`http://seat/settle-commit?round=${toHex(RID)}`), new Uint8Array());
          if (r.ok) flooded += 1;
        }
      }
      return orig(u, o);
    };
  }
  const passes = [];
  let got = null;
  for (const asker of [0, 1, 2]) {
    got = await w.seats[asker].settle(RID).catch((e) => ({ ok: false, why: e.message }));
    passes.push(`seat ${asker}: ${got.state || 'refused'}${got.state === 'ACCEPTED' ? '' : `, ${got.why}`}`);
    if (got.state === 'ACCEPTED') break;
  }
  console.log(`  FACTS: the stranger took ${flooded} commitments; ${passes.join(' | ')}`);
  assert.deepEqual(signedOver(w), [true], `a stranger with no key held the settlement up: ${passes.join(' | ')}`);
});
