// ONE OF FIVE SIGNERS RETURNS A GARBAGE SHARE.
//
// The committee makes its key with no dealer (FROST/DKG). Measured before the
// fix, on these seven daemons over their real doors: `payWithCommittee`
// aggregated whatever the five returned, checked neither the shares nor the
// aggregate, wrote the invalid spend as PAYOUT_QUEUED and sent it; nobody was
// named; and a retry without the cheater was refused by every seat that had
// signed, so the payout was locked for good (TASKBOOK, 5-of-7 bad share).
//
// Now the aggregate is checked before anything is written or sent, each share
// is checked against its seat's public share, the bad one is named, and the
// next attempt - fresh nonces, the cheater left out - pays. The fake chain
// rejects an invalid signature the way bitcoind would, and every raw the asker
// writes to its store is checked too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { PAYOUT_QUEUED } from '../src/payout.js';
import { PoolSigning } from '../src/pool-signing.js';
import { poolOutput } from '../../protocol/src/pool.js';
import { encodeRoundContract, encodeEntryContract, roundId, entryId as entryIdOf } from '../../protocol/src/contracts.js';
import { encodePlayerResult, resultId, joinSignedResult } from '../../protocol/src/result.js';
import { DELIVERED, FORFEIT } from '../../protocol/src/payout.js';
import { scalarFrom32, FIELD, SHARES_NEEDED, SHARES_TOTAL } from '../../protocol/src/shares.js';
import { parseTransaction } from '../../protocol/src/tx.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { assumeSeated } from './seating.js';
import { rand, b32, curve, NOW, POOL_SATS, contractFor, dealThePool } from './pool-fixture.js';

const FUNDED = { funded: () => true };
const post = (port, path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body });
const player = () => { const s = rand(32); return { secret: s, pubkey: schnorr.getPublicKey(s) }; };
const url = (n) => `http://127.0.0.1:${n.port}`;

/** Seven daemons, one round, one queued payout each, one pool share each (pool-committee.test.js's). */
async function committee({ chain }) {
  const dealt = dealThePool();
  const pool = { groupPublicKey: dealt.groupPublicKey };
  // Every seat's public share: what a DKG committee computes from its commitments.
  const publicShares = new Map(dealt.shares.map((s) => [String(s.id), curve.pointFromScalar(s.share)]));
  const nodes = [];
  for (let i = 0; i < SHARES_TOTAL; i++)
    nodes.push(await serve(openStore(':memory:'), {
      port: 0, ...FUNDED, now: () => NOW, poolKey: pool, poolCurve: curve, poolSeat: dealt.shares[i],
      poolPublicShares: publicShares, chainSpend: chain }));
  const contract = contractFor(nodes.map((n) => n.round.pubkey));
  const rid = roundId(contract);
  const session = ed25519.utils.randomSecretKey();
  const entries = [[player(), DELIVERED, 9], [player(), FORFEIT, 0]].map(([p, outcome, score]) => ({
    contract: {
      roundId: rid, playerPubkey: p.pubkey, sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: b32(7), stakeMsat: contract.stakeMsat, feeMsat: entryFeeMsat(contract.stakeMsat),
      donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
    },
    outcome, score, player: p,
  }));
  for (const n of nodes) {
    assert.equal((await post(n.port, '/round', encodeRoundContract(contract))).status, 201);
    assumeSeated(n.round, rid, contract.nodes);
    for (const e of entries) {
      assert.equal((await post(n.port, '/entry', encodeEntryContract(e.contract))).status, 201);
      const eid = entryIdOf(e.contract);
      const result = { roundId: rid, playerPubkey: e.player.pubkey, outcome: e.outcome, score: e.score,
        transcriptHash: b32(0x11), simCoreHash: contract.simCoreHash, nodePubkey: n.round.pubkey };
      const id = resultId(result);
      n.round.putResult(rid, eid, n.round.pubkey, id,
        joinSignedResult(encodePlayerResult(result), schnorr.sign(id, n.round.identity.secret)));
    }
  }
  const entriesOf = (n) => new PoolSigning(n.round, {}).entriesFor(rid).entries;
  for (const n of nodes) n.payouts.sign({ roundId: rid, entries: entriesOf(n), minScore: contract.minScore });
  for (const n of nodes) {
    n.payouts.peers = nodes.filter((o) => o !== n).map(url);
    await n.payouts.gather({ roundId: rid });
    const queued = n.payouts.queue({ roundId: rid, entries: entriesOf(n), minScore: contract.minScore, contract });
    assert.equal(queued.ok, true, queued.why);
  }
  const out = poolOutput({ groupPublicKey: dealt.groupPublicKey, curve });
  const utxo = { txid: b32(0xab), vout: 0, value: POOL_SATS, script: out.script };
  return { nodes, contract, rid, utxo, out, close: () => Promise.all(nodes.map((n) => n.close())) };
}

/** A chain that checks the witness, a cheater at seat 2, and a log of every raw the asker writes. */
async function withCheater(run) {
  const sent = [];
  const box = { sighash: null, outputKey: null };
  const valid = (raw) => {
    try { return schnorr.verify(parseTransaction(raw).witnesses[0][0], box.sighash, box.outputKey); } catch { return false; }
  };
  const chain = { send: async (raw) => {
    const ok = valid(raw);
    sent.push({ raw, ok });
    return ok ? { ok: true, txid: b32(0xcd) } : { ok: false, why: 'rejected: the witness signature does not verify (as bitcoind would)' };
  } };
  const c = await committee({ chain });
  try {
    box.outputKey = c.out.outputKey;
    const asker = c.nodes[0];
    const cheater = c.nodes[1];                                   // seat 2: always among the lowest five
    assert.equal(String(cheater.signing.seat.id), '2');
    cheater.signing.signatureShare = () => ({ ok: true, share: scalarFrom32(rand(32)) % FIELD, id: 2 });
    const mine = asker.signing.spendFor({ roundId: c.rid, utxo: c.utxo, contract: c.contract });
    assert.equal(mine.ok, true, mine.why);
    box.sighash = mine.sighash;
    const written = [];
    const put = asker.round.putPayout.bind(asker.round);
    asker.round.putPayout = (row) => { if (row.raw) written.push(valid(row.raw)); return put(row); };
    const pay = (seats) => asker.payouts.payWithCommittee({ roundId: c.rid, utxo: c.utxo, contract: c.contract,
      signing: asker.signing, seats: seats.map(url) });
    await run({ c, asker, cheaterUrl: url(cheater), pay, sent, written, valid });
  } finally { await c.close(); }
}

test('5 of 7 with a garbage share: nothing invalid is written or sent, seat 2 is named, and the next attempt without it pays', async () => {
  await withCheater(async ({ c, asker, cheaterUrl, pay, sent, written, valid }) => {
    const got = await pay(c.nodes.slice(1));
    const row = asker.round.payout(c.rid);
    const facts = {
      paid: got.ok,
      culprits: got.culprits,
      sent: sent.map((s) => s.ok),
      written,
      rowState: row.state,
      rowRawValid: !!row.raw && valid(new Uint8Array(row.raw)),
      signers: got.seats,
    };
    console.log('  FACTS (5 of 7, one garbage share, all six peers asked):', JSON.stringify(facts));
    assert.deepEqual(facts, {
      paid: true,
      culprits: [{ id: '2', where: cheaterUrl }],
      sent: [true],                        // one transaction reached the chain, and it verifies
      written: [true, true],               // queued and then paid: both raws verify
      rowState: got.state,
      rowRawValid: true,
      signers: ['this seat', ...c.nodes.slice(2, SHARES_NEEDED + 1).map(url)],   // seats 1, 3, 4, 5, 6
    });
    assert.notEqual(got.state, PAYOUT_QUEUED);
  });
});

test('5 of 7, only four honest seats asked: nothing is written or sent and seat 2 is named; a call that leaves it out pays', async () => {
  await withCheater(async ({ c, asker, cheaterUrl, pay, sent, written, valid }) => {
    const first = await pay(c.nodes.slice(1, SHARES_NEEDED));
    const rowAfterFirst = asker.round.payout(c.rid);
    const facts = {
      firstPaid: first.ok,
      culprits: first.culprits,
      whyNamesCheater: String(first.why).includes(cheaterUrl) && /seat 2\b/.test(String(first.why)),
      sentAfterFirst: sent.length,
      writtenAfterFirst: written.length,
      rowAfterFirst: rowAfterFirst.state,
      rawAfterFirst: !!rowAfterFirst.raw,
    };
    console.log('  first why:', first.why);

    const retry = await pay(c.nodes.slice(2));
    const rowFinal = asker.round.payout(c.rid);
    Object.assign(facts, {
      retryPaid: retry.ok,
      sent: sent.map((s) => s.ok),
      written,
      rowFinal: rowFinal.state,
      rowFinalRawValid: !!rowFinal.raw && valid(new Uint8Array(rowFinal.raw)),
    });
    console.log('  FACTS (5 of 7, one garbage share, then a retry without it):', JSON.stringify(facts));
    assert.deepEqual(facts, {
      firstPaid: false,
      culprits: [{ id: '2', where: cheaterUrl }],
      whyNamesCheater: true,
      sentAfterFirst: 0,
      writtenAfterFirst: 0,
      rowAfterFirst: PAYOUT_QUEUED,        // as queue() left it: owed, no raw
      rawAfterFirst: false,
      retryPaid: true,
      sent: [true],
      written: [true, true],
      rowFinal: retry.state,
      rowFinalRawValid: true,
    });
    assert.notEqual(retry.state, PAYOUT_QUEUED);
  });
});
