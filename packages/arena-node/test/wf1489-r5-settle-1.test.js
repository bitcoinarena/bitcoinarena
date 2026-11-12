// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r5-settle-2: a stranger's 85 000-commitment list at POST /settle-share holds the seat's loop (fixture from wf1489-settle-1).
// (fixture copied from settlement-withheld-share.test.js)
// ONE WITHHELD SHARE DOES NOT PIN A SETTLEMENT (kanban #1070). A seat keeps one nonce pair per settlement, and the pair signs one commitment list. A seat that committed
// and then gives no share therefore left every seat that had already signed that list refusing any other ("keeps no second pair") until it restarted, and the seat that
// went on committing was put back on every next list: one seat stopped a settlement the five others could sign.
//
// Seven real LockSettlement instances with a real 5-of-7 FROST key: each seat's own commit, share and take, reached through a fetcher that answers as server.js does, and
// misbehaves for the seats a test names. Only the settlement's bytes are stubbed (`message`), not the signing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';

import { LockSettlement, encodeCommitments, encodeShare, decodeCommitments } from '../src/settlement.js';
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
    const random = (n) => sha256(Uint8Array.from([seed, k, drawn++, n]));
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


// THE DOOR: POST /settle-commit hands any asker a nonce pair of its own (#1494's fix), and POST /settle-share signs over the list the asker
// sends, if it carries that pair's commitment and at least `needed` entries. Nothing caps the list at the round's seats: decodeCommitments
// takes the whole body (8 MiB = 85 598 commitments), and signShare340 computes a binding factor, a point multiplication and a Lagrange
// term for every one of them, synchronously. One stranger's request holds every door of the seat; a loop of them holds it for good.
// Safe: a list naming more participants than the round's signer nodes (or ids outside them) is refused before any curve work.
test('wf1489 r5-settle-2: one stranger\'s huge commitment list at /settle-share is refused at once', async () => {
  const w = seven();
  const k = 0;
  const c = await serve(w.seats[k], new URL(`${base(k)}/settle-commit?round=${toHex(RID)}&txid=${TXID}`), new Uint8Array());
  assert.ok(c.ok, 'the stranger got no commitment (fixture)');
  const own = decodeCommitments(new Uint8Array(await c.arrayBuffer()))[0];
  const N = Math.floor((8 * 1024 * 1024) / 98) - 1;
  const hiding = curve.pointFromScalar(3001n), binding = curve.pointFromScalar(4001n);
  const list = [own];
  for (let id = 1; list.length <= N; id++) if (id !== own.id) list.push({ id, hiding, binding });
  list.sort((a, b) => a.id - b.id);
  const body = encodeCommitments(list);
  const t0 = Date.now();
  const r = await serve(w.seats[k], new URL(`${base(k)}/settle-share?round=${toHex(RID)}`), body);
  const ms = Date.now() - t0;
  console.log(`  FACTS: ${list.length} commitments (${body.length} bytes): answered ${r.status} in ${ms} ms`);
  assert.ok(ms < 2000, `one stranger's commitment list held the seat's loop ${ms} ms`);
  assert.equal(r.ok, false, 'a share was signed over a list of more participants than the round has seats');
});
