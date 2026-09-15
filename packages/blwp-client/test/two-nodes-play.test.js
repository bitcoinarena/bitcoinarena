// TWO NODES, ONE PAGE, THE OTHER TRUCK.
//
// The 2-of-2 already runs: two daemons, two identities, one contract naming
// both signer nodes. This is what a PLAYER sees of it - the pictures that reach the
// page for the other identity's truck, and whether they are that identity's
// own run rather than something the page made up.
//
// The pose in every frame is the CORE's: the daemon replays the transcript
// that player published, through `replay.js`, and this test drives the same
// core over the same inputs and compares. Unity is a television; nothing here
// or there simulates the other truck.
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../../blwp-node/src/cores.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../../blwp-node/src/store.js';
import { serve } from '../../blwp-node/src/server.js';
import { Client } from '../src/client.js';
import { watchGhosts } from '../src/ghost-field.js';
import { encodeInputBatch } from '../../protocol/src/batch.js';
import { GENESIS } from '../../protocol/src/transcript.js';
import { encodeEntryContract, entryId as entryIdOf } from '../../protocol/src/contracts.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { toHex } from '../../protocol/src/hash.js';
import { init as coreInit, step as coreStep } from '../../core/src/sim.js';
import { O_TRUCK, T_X, T_Z, T_HEADING } from '../../core/src/state.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { assumeStakeSeen } from '../../blwp-node/test/assignment.js';
const require = createRequire(import.meta.url);
const core = require('../../core/dist/blwp-core.js');

const b32 = (n) => new Uint8Array(32).fill(n);
const session = ed25519.utils.randomSecretKey();
const sign = (id) => ed25519.sign(id, session);
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const BEACON = b32(0xbe);
const FUNDED = {
  funded: () => true,
  randomnessFor: () => ({ hash: BEACON, height: 900005, timeMs: 900n }),
};
/** The other player's driving: a turn, then the brake comes off at tick 40. */
const words = (t) => [45875, ((t * 986) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];

test('two daemons, one page: the other truck arrives where its own transcript puts it', async () => {
  const a = await serve(openStore(':memory:'), { port: 0, ...FUNDED });
  const b = await serve(openStore(':memory:'), { port: 0, ...FUNDED });
  try {
    // ONE CONTRACT, TWO SIGNER NODES - the 2-of-2 that already runs.
    const contract = {
      networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 6,
      gameVerifySlots: 2, settlementSlots: 2, simCoreHash: TRUCK_CORE_HASH,
      committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
      startTimeMs: 500n + MIN_ENTRY_WINDOW_MS, entryCloseMs: 200000n,
      objectionWindowMs: 600000n, custody: 'THRESHOLD_LN', slashMinimumServed: 20,
      slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
      censusRoot: b32(2), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
      exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
      timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
      nodes: [a.round.pubkey, b.round.pubkey],
    };
    assert.notDeepEqual(a.round.pubkey, b.round.pubkey, 'two daemons share one identity');

    // THIS PLAYER, on node A.
    const client = new Client({ base: `http://127.0.0.1:${a.port}`, core, sign, verify });
    const rid = await client.openRound(contract);
    const mine = {
      roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n,
      joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
    };
    const eid = await client.join(mine);
    // Both daemons gate play on having seen the stake (23.1 step 5); each one
    // that joined this entry is told it did.
    for (const n of [a, b]) if (n.round.entry(entryIdOf(mine))) assumeStakeSeen(n.round, mine);
    await client.connect();
    client.setRound({ roundId: rid, entryId: eid, blockTicks: contract.blockTicks });

    // THE OTHER PLAYER, a second identity in the same round, whose run node A
    // holds: 60 ticks published before this page ever subscribes.
    const theirs = { ...mine, playerPubkey: b32(9), sessionPubkey: b32(10), worldSecret: b32(0x59), vssSharesRef: new Uint8Array(32) };
    await fetch(`http://127.0.0.1:${a.port}/entry`, { method: 'POST', body: encodeEntryContract(theirs) });
    assumeStakeSeen(a.round, theirs);
    const theirEid = entryIdOf(theirs);
    const publish = (first, count) => {
      a.round.batch(encodeInputBatch({
        roundId: rid, entryId: theirEid, previousHash: a.round.head(rid, theirEid),
        firstTick: first, ticks: Array.from({ length: count }, (_, i) => words(first + i)),
        liquidations: [],
      }));
    };
    publish(0, 60);

    // THE PAGE ASKS, and is shown the other truck.
    const field = watchGhosts(client, { roundId: rid, entryId: eid });
    assert.equal(await field.watching, 'watching 1', 'the page was shown nobody');
    await wait(60);
    assert.equal(field.size, 1);

    // ...WHERE THAT IDENTITY'S OWN RUN PUTS IT. The same core, the same
    // inputs, the same seed - driven here rather than taken on trust.
    const st = coreInit(seedWordForEntry(theirs, BEACON));
    const at = new Map();
    for (let t = 0; t < 60; t++) {
      coreStep(st, ...words(t));
      at.set(t, {
        x: st.i32[O_TRUCK + T_X], z: st.i32[O_TRUCK + T_Z], heading: st.i32[O_TRUCK + T_HEADING],
      });
    }
    const first = field.latest()[0];
    assert.deepEqual(toHex(first.entryId), toHex(theirEid), 'that is not the other identity');
    assert.equal(first.tick, 59);
    assert.equal(first.x, at.get(59).x, 'the page has the truck somewhere the core never put it');
    assert.equal(first.z, at.get(59).z);
    assert.equal(first.heading, at.get(59).heading);

    // AND IT MOVES AS THE TRANSCRIPT SAYS. More ticks, another picture, and
    // the truck is somewhere else - the pose is each frame's own.
    const before = field.drain();
    assert.equal(before.length, 1);
    publish(60, 60);
    for (let i = 0; i < 30; i++) client.record([45875, 0, 0, 0, 0]);
    await client.drain();                       // a batch of ours makes the node push
    await wait(60);

    assert.equal(field.size, 1, 'the second stretch of their run never reached the page');
    const later = field.latest()[0];
    assert.equal(later.tick, 119);
    for (let t = 60; t < 120; t++) {
      coreStep(st, ...words(t));
      at.set(t, {
        x: st.i32[O_TRUCK + T_X], z: st.i32[O_TRUCK + T_Z], heading: st.i32[O_TRUCK + T_HEADING],
      });
    }
    assert.equal(later.x, at.get(119).x, 'the truck moved somewhere its transcript does not say');
    assert.equal(later.z, at.get(119).z);
    assert.notEqual(later.x, first.x, 'the truck did not move at all, so this proves nothing');

    // THE FRAMES UNITY WILL DRAW, kept: the exact twelve ints `BlwpNextGhost`
    // hands across, from this real two-node run, so the renderer's own test
    // draws what a player was actually sent rather than numbers invented in
    // C#.
    const asWords = (g) => {
      const out = [];
      for (let i = 0; i < 8; i++) {
        const at4 = i * 4;
        out.push((g.entryId[at4] << 24) | (g.entryId[at4 + 1] << 16)
          | (g.entryId[at4 + 2] << 8) | g.entryId[at4 + 3]);
      }
      out.push(g.x, g.z, g.heading, g.tick);
      return out;
    };
    // THE NUMBER, IN THE LOG. The assertions above already equate the two,
    // but a number nobody can read is a number nobody can check: the pose the
    // page was SHOWN, beside the pose the other player's own transcript drives
    // this core to, at both ticks.
    if (process.env.DUMP_GHOSTS || process.env.PRINT_POSE) {
      const row = (tag, g, c) => console.log(
        `  ${tag}  ghost x ${g.x} z ${g.z} heading ${g.heading}`
        + `   transcript x ${c.x} z ${c.z} heading ${c.heading}`
        + `   delta ${g.x - c.x} ${g.z - c.z} ${g.heading - c.heading}`);
      console.log('the other truck, as shown against as driven:');
      row('tick  59:', first, at.get(59));
      row('tick 119:', later, at.get(119));
    }

    if (process.env.DUMP_GHOSTS) {
      // Twelve ints a line, the way `BlwpNextGhost` writes them, so the
      // renderer's test needs no JSON reader to draw what a player was
      // actually sent.
      const lines = [
        '# Pictures from a two-node run: two daemons, two identities, one page.',
        '# Twelve ints a line - the entry id as eight words, then x, z, heading, tick.',
        `# entry ${toHex(theirEid)}`,
        `# tick ${first.tick}: x ${first.x} z ${first.z} heading ${first.heading}`,
        `# tick ${later.tick}: x ${later.x} z ${later.z} heading ${later.heading}`,
        asWords(first).join(' '),
        asWords(later).join(' '),
      ];
      writeFileSync(process.env.DUMP_GHOSTS, lines.join('\n') + '\n');
    }
  } finally { await a.close(); await b.close(); }
});
