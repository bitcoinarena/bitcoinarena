// THE SIGNER NODE THAT DID NOT SEND THE PAYOUT STILL ENDS PAID.
//
// Measured on the real-lnd rehearsal with the daemons' own 2-of-2 pool (AB and
// BA, 1000-sat stakes): the winner's key held 980 sats in a block, paid by
// one signer node - and the OTHER signer node's row stayed PAYOUT_QUEUED, "1 of 2 signer nodes
// committed to this spend". Its one ask came before the payer had queued its
// table, and nothing asked again: the finality watch stops once no run is
// short, no table is short and no settle is short. The payout's twin of
// M3.3-29's second closer. `settleQueued` already reads the chain first
// (`paidOnChain`) and writes PAID when the pool was spent by exactly this
// signer node's table - it was simply never called again.
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../src/cores.js';
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';
import { PLANTED_FIRST_MARK_DEADLINE } from './planted-marks.js';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { WebSocket } from 'ws';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { HELD, SETTLED, CANCELLED } from '../src/custody.js';
import { PAID, PAID_IN_PART, PAYOUT_QUEUED } from '../src/payout.js';
import { txidToRpc } from '../src/pool-watch.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { assumeAssigned } from './assignment.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { SIGNED_RECEIPT_BYTES } from '../../protocol/src/receipt.js';
import { dealHandout, encodeHandout, handoutId } from '../../protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../protocol/src/shares.js';
import { trustedDealerSplit } from '../../protocol/src/frost.js';
import { evenGroupSecret } from '../../protocol/src/frost-bip340.js';
import { poolOutput } from '../../protocol/src/pool.js';
import { payToKey } from '../../protocol/src/payout-spend.js';
import { parseTransaction } from '../../protocol/src/tx.js';
import { init, step } from '../../core/src/sim.js';
import { hash as stateHash } from '../../core/src/state.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { toHex, fromHex, sha256 } from '../../protocol/src/hash.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const rand = (n) => new Uint8Array(randomBytes(n));
const curve = { ...feldmanGroup, tweakPoint };
const RANDOMNESS = b32(0x9b);
const BEACON_HEIGHT = 900001;
const BEACON = { hash: RANDOMNESS, height: BEACON_HEIGHT, timeMs: 900n };
const GENESIS_HASH = (await import('../../protocol/src/transcript.js')).GENESIS;
const wordsAt = (t) => [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];
const STAKE = 1000000n;            // 1000 sats: the winner's 980 is above the dust floor
const POOL_SATS = 200000n;
const WINDOW_MS = 3000;
const HTLC_EXPIRY = 901000;        // above the fake chain's tip, so no hold expires here
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// THIS FILE KEEPS ITS OWN COPY of window-fixture.js's pair rather than importing it, so the 2026-09-19 re-pick had
// to be made here too: the winner 1d stopped delivering at 1830888 (the 20:30 hold cadence) and by HEAD wrecked at
// tick 192 with score 0, and the loser 0x16 stopped wrecking at all. With a winner that never delivers the payout
// table answers NOTHING_OWED and the loser's hold stays HELD instead of SETTLED, which is what this test measured.
const WINNER = { name: 'winner', key: b32(0x0a), worldSecret: fromHex(`01${'00'.repeat(30)}6d`), ticks: 1320 };
const LOSER = { name: 'loser', key: b32(5), worldSecret: b32(0xc0), ticks: 1000 };

function paidPort() {
  const amounts = new Map();
  return {
    async createHeld({ paymentHash, amountMsat }) { amounts.set(toHex(paymentHash), amountMsat); return { paymentHash, amountMsat, request: 'lnbcrt-x' }; },
    async look({ paymentHash }) { const a = amounts.get(toHex(paymentHash)) || 0n; return { state: HELD, amountMsat: a, paidMsat: a, expiryHeight: HTLC_EXPIRY }; },
    async settle() {}, async cancel() {},
  };
}

/**
 * A BITCOIND WITH ONE POOL OUTPUT, THAT MINES WHAT IT IS SENT.
 *
 * The calls `pool-watch.js` makes, in bitcoind's own shapes: the UTXO set
 * (`scantxoutset`, `gettxout`), the tip, and blocks at verbosity 3 with each
 * input's previous output - which is how a signer node that did not send the payment
 * can see it was made.
 */
function fakeChain(poolScript) {
  const fundTxid = b32(0xab);
  const utxos = [{ txid: fundTxid, vout: 0, sats: POOL_SATS, height: BEACON_HEIGHT - 1 }];
  const mined = new Map();
  const at = { height: BEACON_HEIGHT + 9 };
  const sent = [];
  const call = async (method, params) => {
    if (method === 'getblockcount') return at.height;
    if (method === 'getblockhash') return Number(params[0]).toString(16).padStart(64, '0');
    if (method === 'getblock') return { tx: mined.get(parseInt(params[0], 16)) || [] };
    if (method === 'scantxoutset') return {
      success: true, height: at.height,
      unspents: utxos.map((u) => ({ txid: txidToRpc(u.txid), vout: u.vout, amount: Number(u.sats) / 1e8,
        confirmations: at.height - u.height + 1, scriptPubKey: toHex(poolScript) })),
    };
    if (method === 'gettxout') {
      const u = utxos.find((x) => txidToRpc(x.txid) === params[0] && x.vout === params[1]);
      return u ? { confirmations: at.height - u.height + 1, value: Number(u.sats) / 1e8, scriptPubKey: { hex: toHex(poolScript) } } : null;
    }
    throw new Error(`no fixture for ${method}`);
  };
  const spend = {
    async send(raw) {
      const tx = parseTransaction(raw);
      const spent = tx.inputs.map((i) => utxos.findIndex((u) => toHex(u.txid) === toHex(i.previousTxid) && u.vout === i.previousVout));
      if (spent.some((k) => k < 0)) return { ok: false, why: 'bad-txns-inputs-missingorspent' };
      for (const k of spent.sort((x, y) => y - x)) utxos.splice(k, 1);
      sent.push(raw);
      at.height += 1;
      mined.set(at.height, [{
        txid: txidToRpc(tx.txid), hex: toHex(raw),
        vin: tx.inputs.map((i) => ({ txid: txidToRpc(i.previousTxid), vout: i.previousVout,
          prevout: { value: Number(POOL_SATS) / 1e8, scriptPubKey: { hex: toHex(poolScript) } } })),
        vout: tx.outputs.map((o) => ({ value: Number(o.value) / 1e8, scriptPubKey: { hex: toHex(o.script) } })),
      }]);
      return { ok: true, txid: tx.txid };
    },
    async look(txid) { return { known: sent.some((r) => toHex(parseTransaction(r).txid) === toHex(txid)) }; },
  };
  return { call, spend, sent, at };
}

function dealThePool() {
  let secret;
  do { secret = scalarFrom32(rand(32)); } while (secret === 0n || secret >= FIELD);
  const even = evenGroupSecret(secret, curve);
  return trustedDealerSplit({ secret: even.secret, max: 2, min: 2, coefficients: [scalarFrom32(rand(32))], curve });
}

// P2 (v4.6.2 §13A): the relays each run's transcript is posted to - the
// daemons' own doors - or no result of the round can become final.
const contractFor = (nodes, publicationRelays) => ({
  startDeadlineTicks: PLANTED_FIRST_MARK_DEADLINE, networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 1,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n,
  entryCloseMs: 2000n, objectionWindowMs: BigInt(WINDOW_MS), custody: 'THRESHOLD_LN',
  slashMinimumServed: 20, slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays, donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n,
  randomnessRule: 'bitcoin-block-hash', stakeMsat: STAKE, bondMinSats: 50000n,
  blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
});

const say = (port, message) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/play`);
  ws.on('open', () => ws.send(message));
  ws.on('message', (d, bin) => { resolve(bin ? new Uint8Array(d) : d.toString()); ws.close(); });
  ws.on('error', reject);
});

const secretScalar = () => { let p = rand(32); while (scalarFrom32(p) >= FIELD) p = rand(32); return p; };

async function joinAndPlay(daemons, c, rid, who) {
  const session = ed25519.utils.randomSecretKey();
  const preimage = secretScalar();
  const e = rand(32);
  const dealt = await dealHandout({
    preimage, signerNodes: c.nodes, roundId: rid, playerPubkey: who.key,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
    coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup,
  });
  assert.equal(dealt.ok, true, dealt.why);
  const entry = {
    roundId: rid, playerPubkey: who.key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(preimage), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
    joinTick: 0, worldSecret: who.worldSecret, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0], feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  };
  const eid = entryId(entry);
  const input = { roundId: rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0,
    ticks: Array.from({ length: who.ticks }, (_, t) => wordsAt(t)), liquidations: [] };
  const st = init(seedWordForEntry(entry, RANDOMNESS));
  for (let t = 0; t < who.ticks; t++) step(st, ...wordsAt(t));
  const mark = { roundId: rid, entryId: eid, tick: who.ticks,
    stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
    inputChainHash: batchId(input), previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(session) };
  const signedMark = joinSigned(encodeCheckpoint(mark), ed25519.sign(checkpointId(mark), session));
  for (const d of daemons) {
    assert.equal((await fetch(`http://127.0.0.1:${d.port}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) })).status, 201);
    const joined = await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    assert.equal(joined.status, 201, await joined.text());
    assert.equal((await fetch(`http://127.0.0.1:${d.port}/invoice?entry=${toHex(eid)}`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${d.port}/stake?entry=${toHex(eid)}`)).status, 200);
    assert.equal(await say(d.port, encodeInputBatch(input)), String(who.ticks));
    assert.equal((await say(d.port, signedMark)).length, SIGNED_RECEIPT_BYTES);
  }
  return { eid, entry };
}

test('the signer node whose payout ask came before the other had queued ends PAID once the other has paid - one transaction, 980 sats to the winner', async () => {
  const dealt = dealThePool();
  const pool = { groupPublicKey: dealt.groupPublicKey };
  const out = poolOutput({ groupPublicKey: pool.groupPublicKey, curve });
  const chain = fakeChain(out.script);
  const opts = (i) => ({ port: 0, funded: () => true, randomnessFor: () => BEACON,
    preflight: async () => ({ ready: true, why: 'test port' }), lightning: paidPort(), finality: { everyMs: 100 },
    poolKey: pool, poolSignerNode: dealt.shares[i], poolCurve: curve, poolCall: chain.call, chainSpend: chain.spend });
  const a = await serve(openStore(':memory:'), opts(0));
  const b = await serve(openStore(':memory:'), opts(1));
  try {
    for (const [d, other] of [[a, b], [b, a]]) {
      const there = [`http://127.0.0.1:${other.port}`];
      d.verifier.peers = there; d.payouts.peers = there; d.preimages.peers = there;
    }
    const c = contractFor([a.round.pubkey, b.round.pubkey], [a, b].map((d) => `http://127.0.0.1:${d.port}`));
    const rid = roundId(c);
    for (const d of [a, b]) {
      assert.equal((await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) })).status, 201);
      assumeAssigned(d.round, rid, c.nodes);
    }
    const winner = await joinAndPlay([a, b], c, rid, WINNER);
    const loser = await joinAndPlay([a, b], c, rid, LOSER);

    // THE REHEARSAL'S ORDER, FORCED (instrumentation, as --hold-before-sit
    // forced M3.3-27's): B signs its table but does not queue it until A has
    // asked once. So A agrees the table, asks, and B - not queued - will not
    // commit: A's ask ends "1 of 2 signer nodes committed" with nothing else short on
    // A. B, whose table is still short, queues on its next tick and pays with
    // A's commit.
    let aAsked = false;
    const queueB = b.payouts.queue.bind(b.payouts);
    b.payouts.queue = (q) => {
      if (aAsked) return queueB(q);
      b.payouts.sign({ roundId: q.roundId, entries: q.entries, minScore: q.minScore });
      return { ok: false, agreed: 1, needed: 2, why: 'the test holds B back until A has asked' };
    };
    const settleA = a.payouts.settleQueued.bind(a.payouts);
    a.payouts.settleQueued = async (q) => {
      const r = await settleA(q);
      if (!r.ok && !aAsked) { aAsked = true; console.log(`  A asked first: ${r.why}`); }
      return r;
    };

    const first = say(a.port, `close ${toHex(rid)}`);
    await wait(800);
    assert.deepEqual(await Promise.all([first, say(b.port, `close ${toHex(rid)}`)]), ['closed', 'closed']);

    // WHAT EACH SIGNER NODE'S PAYOUT SAID, in order, until both rows are paid or time is up.
    const said = { A: [], B: [] };
    const rowOf = (d) => (d.round.payout(rid) || {}).state;
    const done = (s) => s === PAID || s === PAID_IN_PART;
    const stop = Date.now() + WINDOW_MS + 15000;
    while (Date.now() < stop && !(done(rowOf(a)) && done(rowOf(b)))) {
      for (const [n, d] of [['A', a], ['B', b]]) {
        const m = await d.stakes();
        const w = m && m.paid ? (m.paid.ok ? m.paid.state : m.paid.why) : null;
        if (w && said[n][said[n].length - 1] !== w) said[n].push(w);
      }
      await wait(100);
    }
    console.log(`  A's payout said: ${JSON.stringify(said.A)}; B's: ${JSON.stringify(said.B)}; rows A ${rowOf(a)}, B ${rowOf(b)}; sent ${chain.sent.length}`);

    assert.equal((a.round.hold(loser.eid) || {}).state, SETTLED);
    assert.equal((a.round.hold(winner.eid) || {}).state, CANCELLED);
    assert.equal(chain.sent.length, 1, `the committee sent ${chain.sent.length} transactions`);
    const tx = parseTransaction(chain.sent[0]);
    const toWinner = tx.outputs.filter((o) => toHex(o.script) === toHex(payToKey(winner.entry.playerPubkey)));
    assert.equal(toWinner.length, 1, 'the winner has no output');
    assert.equal(toWinner[0].value, 980n);
    for (const [n, d] of [['A', a], ['B', b]])
      assert.ok(done(rowOf(d)), `${n} still reads ${rowOf(d)} after the chain carried the payout: ${JSON.stringify(said[n])}`);
    assert.notEqual(rowOf(a), PAYOUT_QUEUED);
  } finally { await a.close(); await b.close(); }
});
