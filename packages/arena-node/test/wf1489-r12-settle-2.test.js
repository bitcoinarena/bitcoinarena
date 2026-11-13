// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r12: the series publisher's fee back (§5A.5) is paid in "round 0, or the first round of the series with entries",
// and each seat decides which round that is from the entries IT holds (server.js publisherFor: round.entriesOf of rounds 0..k-1).
// A seat holds only the entries of the rounds whose committee it sat on, so a seat of round 1 that did not sit on round 0 (which
// had entries and already paid the publisher) names the publisher again in round 1's fee table while a seat that sat on round 0
// does not: the seats of one round build two different settlements (the round never settles at the threshold), or - when
// enough of round 1's seats missed round 0 - the publisher is paid out of the nodes' fee a second time (and in every later
// round whose seats missed every earlier one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { seriesRoundIdOf, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { HOSTED } from './plugins/hosted.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NOW = 1790600000000;
const SERIES = b32(0x51);
const CREATOR = schnorr.getPublicKey(b32(0x33));
const round1 = { seriesId: SERIES, creatorPubkey: CREATOR, roundIndex: 1, nodes: [b32(7), b32(8)], protocolVersion: 3, censusHeight: 900000 };
const rid0 = seriesRoundIdOf(SERIES, 0);
const rid1 = seriesRoundIdOf(SERIES, 1);

const entry0 = {
  roundId: rid0, playerPubkey: b32(0x0a), sessionPubkey: b32(0x0b), stakeCommitment: b32(0x0c), stakeMsat: 100000n, feeMsat: 5000n, donationMsat: 0n,
  joinTick: 0, worldSecret: b32(0x0d), vssSharesRef: new Uint8Array(32), stakePoint: Uint8Array.from([2, ...b32(0x0e)]), feePreimage: b32(0x0f),
  stakeLockOutpoint: { txid: b32(0x10), outIdx: 0n }, feeLockOutpoint: { txid: b32(0x11), outIdx: 1n }, claimKeyAttestationRef: b32(0x12),
};

async function seat({ satOnRound0 }) {
  const s = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, roundClock: () => NOW });
  // the series' publication, proven at this seat (POST /series-publication: anyone posts it to every seat)
  s.round.putSeriesPublication(SERIES, { txid: 'ab'.repeat(32), feeSats: 5000n });
  if (satOnRound0) {
    // round 0 had an entry, held only by the seats of round 0's committee
    const bytes = encodeEntryContract(entry0);
    s.round.db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 1, ?)').run(Buffer.from(rid0), Buffer.from([1, 2, 3]), NOW);
    s.round.db.prepare('INSERT INTO entries (entry_id, round_id, contract, joined_ms) VALUES (?, ?, ?, ?)').run(Buffer.from(entryId(entry0)), Buffer.from(rid0), Buffer.from(bytes), NOW);
  }
  return s;
}

test('two seats of one series round name the same publisher line, whether or not they sat on the round that paid it', async () => {
  const a = await seat({ satOnRound0: true });
  const b = await seat({ satOnRound0: false });
  try {
    assert.equal(a.round.entriesOf(rid0).length, 1, 'seat A holds round 0\'s entry');
    assert.equal(b.round.entriesOf(rid0).length, 0, 'seat B never sat on round 0');
    const pa = a.settlements.signerNodesFor(rid1, round1).publisher || null;
    const pb = b.settlements.signerNodesFor(rid1, round1).publisher || null;
    console.log(`  round 1 publisher line: seat A ${pa ? `${pa.msat} msat` : 'none'}, seat B ${pb ? `${pb.msat} msat` : 'none'}`);
    assert.equal(pb === null ? 'none' : `${pb.msat}`, pa === null ? 'none' : `${pa.msat}`,
      'round 0 had entries and paid the publisher: no seat of round 1 may pay it again, and both seats must build one settlement');
  } finally { await a.close(); await b.close(); }
});
