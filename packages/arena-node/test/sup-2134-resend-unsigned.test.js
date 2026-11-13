// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2134 (after #1629), ported to 1.9 by #2536: A STRANGER SETS NOTHING ON A RE-SEND ATTEMPT. An unsigned /send-commit on a kept attempt
// N+1 drew a pair and an unsigned /send-share over a list of copies spent it, which set the #1629 "signed on" guard and barred the #1241
// lower-hash replace. (The guard across a restart is #2391's, not this test's.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { WinningsSend } from '../src/winnings-send.js';
import * as curve from '../src/curve.js';
import { evenGroupSecret } from '../../arena-protocol/src/frost-bip340.js';
import { trustedDealerSplit } from '../../arena-protocol/src/frost.js';
import { sha256, toHex } from '../../arena-protocol/src/hash.js';

const b = (n) => new Uint8Array(32).fill(n);
const RID = b(0x5e), ENTRY = b(0x21);
const LOW = '11'.repeat(32), HIGH = 'ee'.repeat(32);
const plan = (hash, attempt = 1) => ({ entryId: ENTRY, roundId: RID, attempt, address: 'donor@example.org', invoice: `lnbc-${hash.slice(0, 4)}`, paymentHash: hash,
  invoiceMsat: 9000n, payoutMsat: 9100n, owedMsat: 9500n, gatewayUrl: 'https://gw-b.example', gatewayPk: '02' + 'cd'.repeat(32), expiration: 1200n, why: 'test', donation: true });
const GROUP = evenGroupSecret(0x2134n, curve);
const DEAL = trustedDealerSplit({ secret: GROUP.secret, max: 3, min: 2, coefficients: [9n], curve });
const MSG = b(0xae);

function sender(round, k) {
  let drawn = 0;
  const s = new WinningsSend({ round, port: null, curve, random: (n) => sha256(Uint8Array.from([0x21, 0x34, k, drawn++, n])), peersFor: () => [], fetcher: async () => { throw new Error('no peers'); } });
  s.messageFor = async () => MSG;
  s.built = { ok: true, claimPk: DEAL.groupPublicKey, needed: 2, contract: { nodes: [] }, signerNode: { id: DEAL.shares[k].id, share: DEAL.shares[k].share } };
  return s;
}

test('#2134: on a kept attempt 1 an unsigned ask draws no pair, and a list carrying one nonce under two ids is never signed', async () => {
  const round = new Round(openStore(':memory:'));
  round.putSendPlan({ ...plan('aa'.repeat(32), 0), state: 'FAILED' });
  round.putSendPlan(plan(HIGH));
  const me = sender(round, 0);
  const eHex = toHex(ENTRY);
  const stranger = await me.commit(RID, eHex, me.built, 'auth', 1);
  console.log('  MEASURED unsigned commit on attempt 1:', stranger.ok ? 'drawn' : `${stranger.status} ${stranger.why}`);
  assert.equal(stranger.ok, false, 'an unsigned ask drew a pair on a re-send attempt');
  assert.equal(stranger.status, 403);
  // this seat's own pass, and a made-up list: its own commitment again under another id
  const mine = await me.commit(RID, eHex, me.built, 'auth', 1, { own: true });
  assert.ok(mine.ok, mine.why);
  const copies = await me.share(RID, eHex, me.built, [mine.commitment, { ...mine.commitment, id: DEAL.shares[1].id }].sort((x, y) => x.id - y.id), 'auth', 1, { own: true });
  console.log('  MEASURED copies list:', copies.ok ? 'signed' : copies.why);
  assert.equal(copies.ok, false, 'a list carrying one nonce under two ids is signed');
  assert.equal(me.signedKeys.size, 0, 'the made-up list set the signed-on guard');
  // nothing was signed: the #1241 lower-hash replace still runs
  assert.equal(round.replaceSendPlan(plan(LOW)), true, 'a made-up list pinned the attempt: the lower hash was not taken');
  // an unsigned share on attempt 1 is refused too, before any pair is looked at
  const unsignedShare = await me.share(RID, eHex, me.built, [mine.commitment], 'auth', 1);
  assert.equal(unsignedShare.ok, false);
});
