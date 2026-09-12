// THE LOBBY, AS A NODE SERVES IT (M3.3-34, §25).
//
// "Find a round: link, QR, copied round_id, a lobby - carries nothing." So the
// door lists what THIS node holds and says so: which rounds a player can still
// join, whether each is free (no stake, no Lightning, no wallet), and how many
// players it has seated and taken ticks from. The page checks every listed id
// against its contract before it shows it (lobby.js); this is the node's half.
//
// One seat, five rounds: free and open, free with its committee pending, free
// and past its entry close, paying and open, free and closed. Only the three a
// player could still come to are listed, the open ones first.
//
// MEASURED BEFORE (TASKBOOK, M3.3-34): GET /rounds was 404 - no door listed
// rounds, and a page with no `round=` in its link could only be the offline game.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { assumeSeated } from './seating.js';
import { b32, rand, STAKE, contractFor, say } from './window-fixture.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { encodeInputBatch } from '../../protocol/src/batch.js';
import { GENESIS } from '../../protocol/src/transcript.js';
import { toHex } from '../../protocol/src/hash.js';

const WINDOW = 60000n;          // MIN_ENTRY_WINDOW_MS: committee -> start
const ENTRY = 120000n;          // start -> entry close, as round-2of2 opens them

test('the node lists the rounds a player can still join - free or paying, open or pending - with its own seat counts', async () => {
  const d = await serve(openStore(':memory:'), { port: 0, funded: () => true });
  const base = `http://127.0.0.1:${d.port}`;
  try {
    const now = BigInt(Date.now());
    const round = (committeeTimeMs, extra = {}) => ({
      ...contractFor([d.round.pubkey, b32(0x33)], 3000n, [base]),
      committeeTimeMs, startTimeMs: committeeTimeMs + WINDOW, entryCloseMs: committeeTimeMs + WINDOW + ENTRY,
      stakeMsat: 0n, ...extra,
    });
    const rounds = {
      freeOpen: round(now - 1000n),
      freePending: round(now + 600000n),
      freeEntryOver: round(now - 400000n),
      payingOpen: round(now - 2000n, { stakeMsat: STAKE, federationId: b32(0xfe) }),
      freeClosed: round(now - 3000n),
    };
    const ids = {};
    for (const [name, c] of Object.entries(rounds)) {
      const r = await fetch(`${base}/round`, { method: 'POST', body: encodeRoundContract(c) });
      assert.equal(r.status, 201, `${name}: ${await r.text()}`);
      ids[name] = toHex(roundId(c));
    }
    assumeSeated(d.round, roundId(rounds.freeOpen), rounds.freeOpen.nodes);
    assert.equal(await say(d.port, `close ${ids.freeClosed}`), 'closed');

    // ONE FREE PLAYER, SEATED WITH NO WALLET AND NO LIGHTNING, AND ONE TICK PLAYED.
    const entry = {
      roundId: roundId(rounds.freeOpen), playerPubkey: schnorr.getPublicKey(rand(32)),
      sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
      stakeCommitment: rand(32), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n,
      joinTick: 0, worldSecret: rand(32), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33),
      feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
      feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
    };
    const seated = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    assert.equal(seated.status, 201, await seated.text());
    const played = await say(d.port, encodeInputBatch({ roundId: entry.roundId, entryId: entryId(entry),
      previousHash: GENESIS, firstTick: 0, ticks: [[0, 0, 0, 0, 0]], liquidations: [] }));

    const r = await fetch(`${base}/rounds`);
    const body = r.status === 200 ? await r.json() : null;
    const listed = body ? body.rounds : [];
    const byId = Object.fromEntries(listed.map((x) => [x.id, x]));
    const pick = (x) => x && { phase: x.phase, free: x.free, wallet: x.wallet, seated: x.seated, playing: x.playing, seatedHere: x.seatedHere };
    const facts = {
      status: r.status, played,
      order: listed.map((x) => Object.keys(ids).find((k) => ids[k] === x.id)),
      freeOpen: pick(byId[ids.freeOpen]),
      freePending: pick(byId[ids.freePending]),
      payingOpen: pick(byId[ids.payingOpen]),
    };
    console.log('  FACTS (lobby):', JSON.stringify(facts));
    assert.deepEqual(facts, {
      status: 200, played: '1',
      // open before pending, and among the open the soonest entry close first:
      // payingOpen's committee came 1 s before freeOpen's, so its entry closes first
      order: ['payingOpen', 'freeOpen', 'freePending'],
      freeOpen: { phase: 'open', free: true, wallet: 'none', seated: 1, playing: 1, seatedHere: true },
      freePending: { phase: 'pending', free: true, wallet: 'none', seated: 0, playing: 0, seatedHere: false },
      payingOpen: { phase: 'open', free: false, wallet: 'federation-lock', seated: 0, playing: 0, seatedHere: false },
    });
    // The times the page needs to say "entry closes in 1:42", as the contract has them.
    assert.equal(byId[ids.freeOpen].entryCloseMs, String(rounds.freeOpen.entryCloseMs));
  } finally { await d.close(); }
});
