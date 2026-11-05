// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PROTOCOL-27 DONATION'S RE-SEND IS SIGNED BY S ALONE (kanban #1044 B1, ruling #1134 2): after the settlement, a held donation share's re-send and the
// re-send's auth are signed under KeyAgg(claim_keys[S]) - the key the share's refund names - by every member of the settlement's signer set S with
// BIP-327 MuSig2, at the send commit and share doors (as server.js serves them, here called in place). A seat outside S commits to nothing; a member of S
// gone leaves the share held; a member's nonce signs one list once. Before: the doors made a FROST share under the round's committee key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { WinningsSend, decodeNamedResendList } from '../src/winnings-send.js';
import { signerSetKey } from '../src/named-settlement.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const RID = b32(0x6e);
const seats = [1, 2, 3, 4, 5, 6, 7].map((n) => { const secret = b32(0x40 + n); return { secret, pubkey: schnorr.getPublicKey(secret) }; });
const seatKeys = seats.map((s) => s.pubkey);
const S = [0, 1, 2, 4, 5];
const contract = { protocolVersion: 27, networkId: NETWORK_ID_REGTEST, nodes: seatKeys, settlementSlots: 7 };
const KEY = signerSetKey(seatKeys, 5, S);
const AUTH_MSG = sha256(new TextEncoder().encode('the re-send invoice'));
const rows = [
  { entryId: b32(0x11), roundId: RID, attempt: 0, invoice: '', paymentHash: '', payoutMsat: 100n, owedMsat: 100n, gatewayUrl: 'http://gw0', gatewayPk: '03' + 'cd'.repeat(32), expiration: 500n, donation: true, state: 'HELD', txid: 'aa'.repeat(32) },
  { entryId: b32(0x11), roundId: RID, attempt: 1, invoice: 'lnbcrt-again', paymentHash: 'ab'.repeat(32), payoutMsat: 99n, owedMsat: 100n, gatewayUrl: 'http://gw1', gatewayPk: '03' + 'ce'.repeat(32), expiration: 700n, donation: true, state: 'PLANNED', txid: 'bb'.repeat(32) },
];
const built = { ok: true, named: true, contract, txid: 'aa'.repeat(32), claimPk: KEY, signers: S, plan: { payouts: [] }, batch: { slots: [], signatures: [] } };

function network({ gone = [] } = {}) {
  const sends = seats.map((s, i) => {
    const round = { pubkey: s.pubkey, identity: { secret: s.secret }, sendPlansOf: () => rows, sendAttemptsOf: () => rows, markSend: () => {}, now: () => 0 };
    const port = { send: async () => ({ message: AUTH_MSG }) };
    let n = 0;
    return new WinningsSend({ round, port, random: (k) => sha256(Uint8Array.from([i, n++, k])), peersFor: () => seats.map((_, j) => `http://seat${j}`).filter((_, j) => j !== i),
      fetcher: async (url, opts = {}) => {
        const u = new URL(url);
        const j = Number(u.host.replace('seat', ''));
        if (gone.includes(j)) throw new Error('connection refused');
        const target = sends[j];
        const kind = u.searchParams.get('kind'), attempt = Number(u.searchParams.get('attempt')), entry = u.searchParams.get('entry');
        const got = u.pathname === '/send-commit'
          ? await target.commit(RID, entry, built, kind, attempt)
          : await target.share(RID, entry, built, decodeNamedResendList(new Uint8Array(opts.body)), kind, attempt);
        return got.ok ? new Response(got.wire, { status: 200 }) : new Response(got.why, { status: 409 });
      } });
  });
  return sends;
}

test('the re-send\'s auth is signed by every member of S under KeyAgg(S), asked by a member or by a seat outside S', async () => {
  for (const asker of [0, 3]) {
    const sends = network();
    const got = await sends[asker].sign(RID, rows[1], built, 'auth');
    assert.equal(got.ok, true, got.why);
    assert.equal(schnorr.verify(got.signature, AUTH_MSG, KEY.subarray(1)), true, 'the signature is S\'s, under the share\'s refund key');
  }
});

test('a seat outside S commits to nothing; a member of S gone leaves the share held', async () => {
  const sends = network();
  const out = await sends[3].commit(RID, toHex(rows[1].entryId), built, 'auth', 1);
  assert.equal(out.ok, false);
  assert.match(out.why, /not in the signer set S/);
  const held = await network({ gone: [5] })[0].sign(RID, rows[1], built, 'auth');
  assert.equal(held.ok, false);
  assert.equal(held.held, true);
  assert.match(held.why, /seat\(s\) 5 of the signer set S/);
});

test('a member signs one list under one nonce: a second list, or a list that is not S, is refused', async () => {
  const sends = network();
  const e = toHex(rows[1].entryId);
  const members = [];
  for (const i of S) { const c = await sends[i].commit(RID, e, built, 'auth', 1); assert.equal(c.ok, true, c.why); members.push({ seat: i, pubnonces: c.pubnonces }); }
  const first = await sends[1].share(RID, e, built, members, 'auth', 1);
  assert.equal(first.ok, true, first.why);
  const again = await sends[1].share(RID, e, built, members, 'auth', 1);
  assert.equal(toHex(again.partial), toHex(first.partial), 'the same list answers the same partial');
  const other = members.map((m) => (m.seat === 4 ? { ...m, pubnonces: members[0].pubnonces } : m));
  assert.match((await sends[1].share(RID, e, built, other, 'auth', 1)).why, /another list/);
  assert.match((await sends[2].share(RID, e, built, members.slice(0, 4), 'auth', 1)).why, /not the signer set S/);
});
