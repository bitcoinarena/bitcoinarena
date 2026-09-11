// MEASURED: ONE OF FIVE SIGNERS RETURNS A GARBAGE SHARE.
//
// The committee makes its key with no dealer (FROST/DKG). Signing with it is
// the open half: `payWithCommittee` aggregates whatever shares the five return,
// checks neither the shares nor the aggregate, writes the raw transaction as
// PAYOUT_QUEUED, and sends it. This records, on seven daemons over their real
// doors, what one dishonest signer does to a payout today - and asserts it, so
// the fix has something to turn over. The fake chain rejects an invalid
// signature the way bitcoind would.
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

/** Seven daemons, one round, one queued payout each, one pool share each (pool-committee.test.js's). */
async function committee({ chain }) {
  const dealt = dealThePool();
  const pool = { groupPublicKey: dealt.groupPublicKey };
  const nodes = [];
  for (let i = 0; i < SHARES_TOTAL; i++)
    nodes.push(await serve(openStore(':memory:'), {
      port: 0, ...FUNDED, now: () => NOW, poolKey: pool, poolCurve: curve, poolSeat: dealt.shares[i], chainSpend: chain }));
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
    n.payouts.peers = nodes.filter((o) => o !== n).map((o) => `http://127.0.0.1:${o.port}`);
    await n.payouts.gather({ roundId: rid });
    const queued = n.payouts.queue({ roundId: rid, entries: entriesOf(n), minScore: contract.minScore, contract });
    assert.equal(queued.ok, true, queued.why);
  }
  const out = poolOutput({ groupPublicKey: dealt.groupPublicKey, curve });
  const utxo = { txid: b32(0xab), vout: 0, value: POOL_SATS, script: out.script };
  return { nodes, contract, rid, utxo, out, close: () => Promise.all(nodes.map((n) => n.close())) };
}

test('5 of 7: one of the five signers returns a garbage share', async () => {
  const sent = [];
  let sighash = null;
  let outputKey = null;
  const valid = (raw) => { try { return schnorr.verify(parseTransaction(raw).witnesses[0][0], sighash, outputKey); } catch { return false; } };
  const chain = { send: async (raw) => {
    const ok = valid(raw);
    sent.push({ raw, ok });
    return ok ? { ok: true, txid: b32(0xcd) } : { ok: false, why: 'rejected: the witness signature does not verify (as bitcoind would)' };
  } };
  const c = await committee({ chain });
  try {
    outputKey = c.out.outputKey;
    const asker = c.nodes[0];
    const cheater = c.nodes[1];                                   // seat 2: always among the lowest five
    const cheaterUrl = `http://127.0.0.1:${cheater.port}`;
    cheater.signing.signatureShare = () => ({ ok: true, share: scalarFrom32(rand(32)) % FIELD, id: 2 });
    const mine = asker.signing.spendFor({ roundId: c.rid, utxo: c.utxo, contract: c.contract });
    assert.equal(mine.ok, true, mine.why);
    sighash = mine.sighash;

    const first = await asker.payouts.payWithCommittee({ roundId: c.rid, utxo: c.utxo, contract: c.contract,
      signing: asker.signing, seats: c.nodes.slice(1, SHARES_NEEDED).map((n) => `http://127.0.0.1:${n.port}`) });
    const rowAfterFirst = asker.round.payout(c.rid);
    const facts = {
      firstPaid: first.ok,
      sentAfterFirst: sent.length,
      anySentValid: sent.some((s) => s.ok),
      rowAfterFirst: rowAfterFirst.state,
      invalidRawQueued: !!rowAfterFirst.raw && !valid(new Uint8Array(rowAfterFirst.raw)),
      cheaterNamed: String(first.why || '').includes(cheaterUrl) || /seat 2\b/.test(String(first.why || '')),
    };

    // A RETRY THAT LEAVES THE CHEATER OUT: the asker and seats 3-7 - still five honest signers.
    const retry = await asker.payouts.payWithCommittee({ roundId: c.rid, utxo: c.utxo, contract: c.contract,
      signing: asker.signing, seats: c.nodes.slice(2).map((n) => `http://127.0.0.1:${n.port}`) });
    facts.retryPaid = retry.ok;
    facts.sentTotal = sent.length;
    facts.rowFinal = asker.round.payout(c.rid).state;
    console.log('  FACTS (5 of 7, one garbage share):', JSON.stringify(facts));
    console.log('  first why:', first.why);
    console.log('  retry why:', retry.why, JSON.stringify(retry.refused || []));

    // TODAY (as measured): the invalid spend is written as queued and sent, nobody is named,
    // and the retry without the cheater does not pay.
    assert.deepEqual(facts, {
      firstPaid: false, sentAfterFirst: 1, anySentValid: false, rowAfterFirst: PAYOUT_QUEUED,
      invalidRawQueued: true, cheaterNamed: false, retryPaid: false, sentTotal: facts.sentTotal, rowFinal: PAYOUT_QUEUED,
    });
  } finally { await c.close(); }
});
