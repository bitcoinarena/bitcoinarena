// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LOBBY, AS A NODE SERVES IT (M3.3-34, §25).
//
// "Find a round: link, QR, copied round_id, a lobby - carries nothing." So the
// door lists what THIS node holds and says so: which rounds a player can still
// join, whether each is free (no stake, no Lightning, no wallet), and how many
// players it has joined and taken ticks from. The page checks every listed id
// against its contract before it shows it (lobby.js); this is the node's half.
//
// One signer node, five rounds: free and open, free with its committee pending, free
// and past its entry close, paying and open, free and closed. Every round that has not ended is listed (ROUNDS-EP-1612,
// 2026-09-28: "It lists every announced round") - the one past its entry close too, saying entryOpen false - and
// the closed one is not; the open ones first.
//
// MEASURED BEFORE (TASKBOOK, M3.3-34): GET /rounds was 404 - no door listed
// rounds, and a page with no `round=` in its link could only be the offline game.
// A PAYING ROUND OPENS ONLY ON A SIGNER NODE THAT REACHES A FEDERATION (RULED 2026-09-25): this file's paying-round
// daemons get the lock fixture's port - the test federation, two gateways, zero base fee. Contracts unchanged.
import { lockPort, bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { test } from 'node:test';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { assumeAssigned } from './assignment.js';
import { b32, rand, STAKE, contractFor, say } from './window-fixture.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { encodeInputBatch } from '../../arena-protocol/src/batch.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { lobbyListingId } from '../../arena-protocol/src/lobby-listing.js';
import { HOSTED } from './plugins/hosted.js';

const WINDOW = 60000n;          // MIN_ENTRY_WINDOW_MS: committee -> start
const ENTRY = 120000n;          // start -> entry close, as round-2of2 opens them

test('the node lists the rounds a player can still join - free or paying, open or pending - with its own signer node counts', async () => {
  // ON A CHAIN THAT BONDS THE ROUND'S TWO NODES (RULED 2026-09-25): the one daemon and a keyless placeholder, so the claim
  // key is claimKeyFor's. A node with a chain view checks every round's census, free ones too: each round's censusRoot is
  // bonded just before it is posted, and nothing else in it changes.
  const slot = bondedChainSlot(lockPort());
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, stakeLocks: slot.port, funded: () => true, chainFor: slot.chainFor,
    randomnessFor: slot.randomnessFor, claimKeyFor: () => new Uint8Array(33).fill(2) });
  const base = `http://127.0.0.1:${d.port}`;
  try {
    const now = BigInt(Date.now());
    const round = (committeeTimeMs, extra = {}) => ({
      ...contractFor([d.round.pubkey, b32(0x33)], 3000n, [base]),
      committeeTimeMs, startTimeMs: committeeTimeMs + WINDOW, entryCloseMs: committeeTimeMs + WINDOW + ENTRY,
      stakeMsat: 0n, ...extra,
    });
    const bonded = (c) => ({ ...c, censusRoot: bondedChainFor(c.nodes, c, slot, { endpoints: [`ws://127.0.0.1:${d.port}`] }).censusRoot });
    const rounds = {
      freeOpen: round(now - 1000n),
      freePending: round(now + 600000n),
      freeEntryOver: round(now - 400000n),
      payingOpen: round(now - 2000n, { stakeMsat: STAKE, custody: 'FEDERATION', federationId: TEST_FEDERATION_ID }),
      freeClosed: round(now - 3000n),
    };
    const ids = {};
    for (const [name, drafted] of Object.entries(rounds)) {
      const c = rounds[name] = bonded(drafted);
      const r = await fetch(`${base}/round`, { method: 'POST', body: encodeRoundContract(c) });
      assert.equal(r.status, 201, `${name}: ${await r.text()}`);
      ids[name] = toHex(roundId(c));
    }
    assumeAssigned(d.round, roundId(rounds.freeOpen), rounds.freeOpen.nodes);
    assert.equal(await say(d.port, `close ${ids.freeClosed}`), 'closed');

    // ONE FREE PLAYER, JOINED WITH NO WALLET AND NO LIGHTNING, AND ONE TICK PLAYED.
    const entry = {
      roundId: roundId(rounds.freeOpen), playerPubkey: schnorr.getPublicKey(rand(32)),
      sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
      stakeCommitment: rand(32), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n,
      joinTick: 0, worldSecret: rand(32), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33),
      feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
      feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
    };
    const joined = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    assert.equal(joined.status, 201, await joined.text());
    const played = await say(d.port, encodeInputBatch({ roundId: entry.roundId, entryId: entryId(entry),
      previousHash: GENESIS, firstTick: 0, ticks: [[0, 0, 0, 0, 0]], liquidations: [] }));

    const r = await fetch(`${base}/rounds`);
    const body = r.status === 200 ? await r.json() : null;
    const listed = body ? body.rounds : [];
    const byId = Object.fromEntries(listed.map((x) => [x.id, x]));
    const pick = (x) => x && { phase: x.phase, entryOpen: x.entryOpen, free: x.free, wallet: x.wallet, joined: x.joined, playing: x.playing, assignedHere: x.assignedHere };
    const facts = {
      status: r.status, played,
      order: listed.map((x) => Object.keys(ids).find((k) => ids[k] === x.id)),
      freeOpen: pick(byId[ids.freeOpen]),
      freePending: pick(byId[ids.freePending]),
      payingOpen: pick(byId[ids.payingOpen]),
      freeEntryOver: pick(byId[ids.freeEntryOver]),
    };
    console.log('  FACTS (lobby):', JSON.stringify(facts));
    assert.deepEqual(facts, {
      status: 200, played: '1',
      // open before pending, and among the open the soonest entry close first:
      // payingOpen's committee came 1 s before freeOpen's, so its entry closes first
      // the round past its entry close is announced still (it has not ended), and its entry closed soonest
      order: ['freeEntryOver', 'payingOpen', 'freeOpen', 'freePending'],
      freeOpen: { phase: 'open', entryOpen: true, free: true, wallet: 'none', joined: 1, playing: 1, assignedHere: true },
      // ASSIGNED HERE BY THE CHAIN (2026-09-25): the bonded census names this daemon and the round has a slot for each of
      // its two nodes, so the node is assigned to every round it opened. Measured before the chain view: false, because a
      // node with no chain view assigned nobody and only freeOpen was forced by assumeAssigned.
      freePending: { phase: 'pending', entryOpen: false, free: true, wallet: 'none', joined: 0, playing: 0, assignedHere: true },
      payingOpen: { phase: 'open', entryOpen: true, free: false, wallet: 'federation-lock', joined: 0, playing: 0, assignedHere: true },
      freeEntryOver: { phase: 'open', entryOpen: false, free: true, wallet: 'none', joined: 0, playing: 0, assignedHere: true },
    });
    // The times the page needs to say "entry closes in 1:42", as the contract has them.
    assert.equal(byId[ids.freeOpen].entryCloseMs, String(rounds.freeOpen.entryCloseMs));

    // 2-OF-2: EACH ROW IS THIS SIGNER NODE'S SIGNED WORD, and says the round's threshold.
    // The page counts distinct signer nodes of the round that signed "open, joined";
    // what one signer node signed cannot be read as another's, or changed after.
    assert.equal(body.node, toHex(d.round.pubkey));
    const signedAs = (x, change = {}) => lobbyListingId({ roundId: fromHex(x.id), nodePubkey: d.round.pubkey,
      nowMs: BigInt(body.nowMs), phase: x.phase, assignedHere: x.assignedHere, joined: x.joined, playing: x.playing, ...change });
    const verified = listed.map((x) => schnorr.verify(fromHex(x.sig), signedAs(x), d.round.pubkey));
    const open = byId[ids.freeOpen];
    const tampered = {
      joined: schnorr.verify(fromHex(open.sig), signedAs(open, { joined: open.joined + 1 }), d.round.pubkey),
      assignedHere: schnorr.verify(fromHex(open.sig), signedAs(open, { assignedHere: false }), d.round.pubkey),
      anotherKey: schnorr.verify(fromHex(open.sig), signedAs(open, { nodePubkey: b32(0x33) }), b32(0x33)),
    };
    console.log('  signed (2-of-2):', JSON.stringify({ verified, needed: open.needed, signerNodes: open.signerNodes, tampered }));
    assert.deepEqual({ verified, needed: open.needed, signerNodes: open.signerNodes, tampered },
      { verified: [true, true, true, true], needed: 2, signerNodes: 2, tampered: { joined: false, assignedHere: false, anotherKey: false } });
  } finally { await d.close(); }
});
