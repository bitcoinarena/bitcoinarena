// A LOST STAKE OPENS AT THE ROUND'S THRESHOLD, THROUGH THE REAL CLOSE (M3.3-26).
//
// Measured on the regtest rehearsal before the fix: both daemons reached the
// loser's settle holding both shares of a stake dealt 2-of-2, and stopped at
// "2 of 5 shares" - the settle's `open()` asked SHARES_NEEDED, whatever the
// round. The door tests pin what a handout may be dealt at; this pins what the
// settle opens at: two daemons, one 2-of-2 stake, one run that wrecks and turns
// final on both, and each daemon's settle hook must open the preimage the hold
// was made for. A mutant that drops the round's number from `open()` opens none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { WebSocket } from 'ws';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { HELD } from '../src/custody.js';
import { feldmanGroup } from '../src/curve.js';
import { assumeSeated, assumeStakeSeen } from './seating.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { SIGNED_RECEIPT_BYTES } from '../../protocol/src/receipt.js';
import { dealHandout, encodeHandout, handoutId } from '../../protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../protocol/src/shares.js';
import { init, step } from '../../core/src/sim.js';
import { hash as stateHash } from '../../core/src/state.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const rand = (n) => new Uint8Array(randomBytes(n));
const RANDOMNESS = b32(0x9b);
const BEACON = { hash: RANDOMNESS, height: 900001, timeMs: 900n };
const GENESIS_HASH = (await import('../../protocol/src/transcript.js')).GENESIS;
const TICKS = 1000;   // close-order's drive: this world secret wrecks at tick 547
const wordsAt = (t) => [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];
const session = ed25519.utils.randomSecretKey();
const STAKE = 100000n;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A Lightning node whose players have paid: every hold reads held in full. */
function paidPort() {
  const amounts = new Map();
  return {
    async createHeld({ paymentHash, amountMsat }) { amounts.set(toHex(paymentHash), amountMsat); return { paymentHash, amountMsat, request: 'lnbcrt-x' }; },
    async look({ paymentHash }) { const a = amounts.get(toHex(paymentHash)) || 0n; return { state: HELD, amountMsat: a, paidMsat: a }; },
    async settle() {}, async cancel() {},
  };
}

const contractFor = (nodes) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: b32(1), startTimeMs: 60500n,
  entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION',
  slashMinimumServed: 20, slashRemainder: 'BURN', donationSetId: b32(0xd0),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n,
  randomnessRule: 'bitcoin-block-hash', stakeMsat: STAKE, bondMinSats: 50000n,
  blockTicks: 9000, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
});

const say = (port, message) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/play`);
  ws.on('open', () => ws.send(message));
  ws.on('message', (d, bin) => { resolve(bin ? new Uint8Array(d) : d.toString()); ws.close(); });
  ws.on('error', reject);
});

const secretScalar = () => { let p = rand(32); while (scalarFrom32(p) >= FIELD) p = rand(32); return p; };

test('each daemon\'s settle opens a 2-of-2 stake with its 2 shares - not "2 of 5"', async () => {
  const opts = { funded: () => true, randomnessFor: () => BEACON,
    preflight: async () => ({ ready: true, why: 'test port' }), finality: { everyMs: 50 } };
  const portA = paidPort();
  const portB = paidPort();
  const a = await serve(openStore(':memory:'), { port: 0, ...opts, lightning: portA });
  const b = await serve(openStore(':memory:'), { port: 0, ...opts, lightning: portB });
  try {
    for (const [d, other] of [[a, b], [b, a]]) {
      d.verifier.peers = [`http://127.0.0.1:${other.port}`];
      d.payouts.peers = [`http://127.0.0.1:${other.port}`];
      d.preimages.peers = [`http://127.0.0.1:${other.port}`];   // no census here: the operator's list
    }
    const c = contractFor([a.round.pubkey, b.round.pubkey]);
    const rid = roundId(c);

    // THE STAKE, DEALT THE WAY THE PAGE DEALS IT: the round's 2 of its 2 seats.
    const preimage = secretScalar();
    const e = rand(32);
    const dealt = await dealHandout({
      preimage, seats: c.nodes, roundId: rid, playerPubkey: b32(5),
      ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
      coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup,
    });
    assert.equal(dealt.ok, true, dealt.why);

    const entry = {
      roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: sha256(preimage), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
      joinTick: 0, worldSecret: b32(0x16), vssSharesRef: handoutId(dealt.handout),
    };
    const eid = entryId(entry);
    const input = { roundId: rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0,
      ticks: Array.from({ length: TICKS }, (_, t) => wordsAt(t)), liquidations: [] };
    const st = init(seedWordForEntry(entry, RANDOMNESS));
    for (let t = 0; t < TICKS; t++) step(st, ...wordsAt(t));
    const mark = { roundId: rid, entryId: eid, tick: TICKS,
      stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
      inputChainHash: batchId(input), previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(session) };
    const signedMark = joinSigned(encodeCheckpoint(mark), ed25519.sign(checkpointId(mark), session));

    for (const d of [a, b]) {
      await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
      assumeSeated(d.round, rid, c.nodes);
      const took = await fetch(`http://127.0.0.1:${d.port}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
      assert.equal(took.status, 201, await took.text());
      const seated = await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
      assert.equal(seated.status, 201, await seated.text());
      const quote = await fetch(`http://127.0.0.1:${d.port}/invoice?entry=${toHex(eid)}`);
      assert.equal(quote.status, 200, await quote.text());
      assumeStakeSeen(d.round, entry);
      assert.equal(await say(d.port, encodeInputBatch(input)), String(TICKS));
      assert.equal((await say(d.port, signedMark)).length, SIGNED_RECEIPT_BYTES);
    }

    for (const d of [a, b]) {
      assert.equal(await say(d.port, `close ${toHex(rid)}`), 'closed');
      await d.verifier.settling;
    }
    const final = async (d) => ((await d.stakes()).agreed || []).includes(toHex(eid));
    const stop = Date.now() + 8000;
    while (Date.now() < stop && !((await final(a)) && (await final(b)))) await wait(50);
    for (const d of [a, b]) assert.equal(await final(d), true, 'the run never turned final on both seats');

    // THE SETTLE'S OWN OPENING. A lone loser moves no stake - the round's money
    // rule refuses a pool with nobody handed anything ("the operator would keep
    // 98000 msat") - so the close never reaches it here; the rehearsal, with a
    // winner beside the loser, does. What the settle calls is the custody's
    // `preimageFor`, which is the daemon's `fromTheCommittee`: its own share
    // plus the other seat's, asked for over HTTP, opened at the round's number.
    for (const [name, d] of [['A', a], ['B', b]]) {
      const got = await d.custody.preimageFor(eid, entry, rid);
      assert.ok(got instanceof Uint8Array, `${name} opened no preimage from the 2 shares of a 2-of-2 stake`);
      assert.equal(toHex(got), toHex(preimage), `${name} opened a different preimage`);
    }
  } finally { await a.close(); await b.close(); }
});
