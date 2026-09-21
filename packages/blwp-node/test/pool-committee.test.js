// SEVEN DAEMONS ON SEVEN PORTS, AND THE POOL IS SPENT BY FIVE OF THEM.
//
// `pool-signing.test.js` proves a signer node's rules with the signer nodes in one process.
// This puts them on sockets, which is the difference between "the arithmetic
// works" and "a committee did it": the asker holds ONE share, the other four
// are answers off a wire, and a signer node that will not sign says so with a status
// code rather than by being absent from a `map`.
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../src/cores.js';
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { PAYOUT_QUEUED, PAID } from '../src/payout.js';
import { tableFor } from '../src/payout-table.js';
import { PoolSigning } from '../src/pool-signing.js';
import { encodeUtxo, decodeCommitments, encodeShareRequest } from '../src/pool-wire.js';
import { trustedDealerSplit } from '../../protocol/src/frost.js';
import { evenGroupSecret } from '../../protocol/src/frost-bip340.js';
import { poolOutput } from '../../protocol/src/pool.js';
import { encodeRoundContract, encodeEntryContract, roundId, entryId as entryIdOf } from '../../protocol/src/contracts.js';
import { encodePlayerResult, resultId, joinSignedResult } from '../../protocol/src/result.js';
import { DELIVERED, FORFEIT } from '../../protocol/src/payout.js';
import { scalarFrom32, FIELD, SHARES_NEEDED, SHARES_TOTAL } from '../../protocol/src/shares.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { assumeAssigned } from './assignment.js';
import { toHex } from '../../protocol/src/hash.js';
import { parseTransaction } from '../../protocol/src/tx.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../protocol/src/fee.js';
const rand = (n) => new Uint8Array(randomBytes(n));
const b32 = (n) => new Uint8Array(32).fill(n);
const curve = { ...feldmanGroup, tweakPoint };
const NOW = 1788700000000;
const POOL_SATS = 200000n;
const FUNDED = { funded: () => true };

const contractFor = (nodes) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 1,
  gameVerifySlots: SHARES_TOTAL, settlementSlots: SHARES_TOTAL, simCoreHash: TRUCK_CORE_HASH,
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
  startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
  entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
  objectionWindowMs: 600000n, custody: 'THRESHOLD_LN', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat: 1000000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes,
});

const player = () => { const s = rand(32); return { secret: s, pubkey: schnorr.getPublicKey(s) }; };

function dealThePool() {
  let secret;
  do { secret = scalarFrom32(rand(32)); } while (secret === 0n || secret >= FIELD);
  const even = evenGroupSecret(secret, curve);
  return trustedDealerSplit({
    secret: even.secret, max: SHARES_TOTAL, min: SHARES_NEEDED,
    coefficients: Array.from({ length: SHARES_NEEDED - 1 }, () => scalarFrom32(rand(32))),
    curve,
  });
}

const post = (port, path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body });

/** Seven daemons, one round, one queued payout each, one share each. */
async function committee({ chain = null } = {}) {
  const dealt = dealThePool();
  const pool = { groupPublicKey: dealt.groupPublicKey };

  // THE KEYS FIRST, because the round id is a hash of the contract that names
  // them and all seven have to open the same round.
  const nodes = [];
  for (let i = 0; i < SHARES_TOTAL; i++) {
    nodes.push(await serve(openStore(':memory:'), {
      port: 0, ...FUNDED, now: () => NOW,
      poolKey: pool, poolCurve: curve, poolSignerNode: dealt.shares[i],
      ...(chain ? { chainSpend: chain } : {}),
    }));
  }
  const contract = contractFor(nodes.map((n) => n.round.pubkey));
  const rid = roundId(contract);

  const winner = player();
  const loser = player();
  const session = ed25519.utils.randomSecretKey();
  const entries = [[winner, DELIVERED, 9], [loser, FORFEIT, 0]].map(([p, outcome, score]) => ({
    contract: {
      roundId: rid, playerPubkey: p.pubkey, sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: b32(7), stakeMsat: contract.stakeMsat, feeMsat: entryFeeMsat(contract.stakeMsat),
      donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
    },
    outcome, score, player: p,
  }));

  for (const n of nodes) {
    assert.equal((await post(n.port, '/round', encodeRoundContract(contract))).status, 201);
    assumeAssigned(n.round, rid, contract.nodes);
    for (const e of entries) {
      assert.equal((await post(n.port, '/entry', encodeEntryContract(e.contract))).status, 201);
      // THE SIGNER NODE'S OWN VERDICT. A close would put these here; this file is
      // about what happens after one, so they are put here directly and each
      // is signed under the signer node's own key, which is what `entriesFor` reads.
      const eid = entryIdOf(e.contract);
      const result = {
        roundId: rid, playerPubkey: e.player.pubkey, outcome: e.outcome, score: e.score,
        transcriptHash: b32(0x11), simCoreHash: contract.simCoreHash, nodePubkey: n.round.pubkey,
      };
      const id = resultId(result);
      n.round.putResult(rid, eid, n.round.pubkey, id,
        joinSignedResult(encodePlayerResult(result), schnorr.sign(id, n.round.identity.secret)));
    }
  }

  // EVERY SIGNER NODE SIGNS THE TABLE IT COMPUTED, and then fetches the others'
  // through the door that serves them - `gather`, over real HTTP.
  const entriesOf = (n) => new PoolSigning(n.round, {}).entriesFor(rid).entries;
  for (const n of nodes)
    n.payouts.sign({ roundId: rid, entries: entriesOf(n), minScore: contract.minScore });
  for (const n of nodes) {
    n.payouts.peers = nodes.filter((o) => o !== n).map((o) => `http://127.0.0.1:${o.port}`);
    await n.payouts.gather({ roundId: rid });
    const queued = n.payouts.queue({
      roundId: rid, entries: entriesOf(n), minScore: contract.minScore, contract,
    });
    assert.equal(queued.ok, true, queued.why);
    assert.equal(queued.state, PAYOUT_QUEUED);
  }

  const out = poolOutput({ groupPublicKey: dealt.groupPublicKey, curve });
  const utxo = { txid: b32(0xab), vout: 0, value: POOL_SATS, script: out.script };
  return { nodes, dealt, pool, contract, rid, utxo, out, winner, loser,
    close: () => Promise.all(nodes.map((n) => n.close())) };
}

test('five daemons sign one spend of the pool over the wire, and the asker holds one share', async () => {
  const sent = [];
  const chain = { send: async (raw) => { sent.push(raw); return { ok: true, txid: b32(0xcd) }; } };
  const c = await committee({ chain });
  try {
    const asker = c.nodes[0];
    const others = c.nodes.slice(1, SHARES_NEEDED).map((n) => `http://127.0.0.1:${n.port}`);
    assert.equal(others.length, SHARES_NEEDED - 1, 'the asker is one of the five');

    // The sighash every signer node computes for itself, taken BEFORE the payout is
    // sent: a paid row is not a queued one, and a signer node will not rebuild a
    // spend for a round it has already paid.
    const mine = asker.signing.spendFor({ roundId: c.rid, utxo: c.utxo, contract: c.contract });
    assert.equal(mine.ok, true, mine.why);

    const paid = await asker.payouts.payWithCommittee({
      roundId: c.rid, utxo: c.utxo, contract: c.contract,
      signing: asker.signing, signerNodes: others,
    });
    assert.equal(paid.ok, true, `${paid.why} ${JSON.stringify(paid.refused)}`);
    assert.equal(paid.state, PAID);
    assert.equal(paid.signed, SHARES_NEEDED);
    assert.equal(sent.length, 1, 'the committee sent something other than one transaction');

    // AND IT IS A SPEND THE POOL OUTPUT WOULD ACCEPT. The witness is one
    // BIP-340 signature over the sighash every signer node computed for itself.
    const tx = parseTransaction(sent[0]);
    assert.equal(tx.witnesses[0].length, 1, 'that is not a key-path spend');
    assert.equal(tx.witnesses[0][0].length, 64);
    assert.ok(schnorr.verify(tx.witnesses[0][0], mine.sighash, c.out.outputKey),
      'five daemons produced no signature the pool output would take');

    // THE ROW SAYS WHO PAID IT, and the raw bytes are on disk.
    const row = asker.round.payout(c.rid);
    assert.equal(row.state, PAID);
    assert.deepEqual(row.txid, b32(0xcd));
    assert.deepEqual(new Uint8Array(row.raw), sent[0]);
  } finally { await c.close(); }
});

test('four daemons do not spend the pool, and the asker says how many committed', async () => {
  const chain = { send: async () => { throw new Error('four signer nodes reached the chain'); } };
  const c = await committee({ chain });
  try {
    const asker = c.nodes[0];
    // Three peers plus the asker is four.
    const others = c.nodes.slice(1, SHARES_NEEDED - 1).map((n) => `http://127.0.0.1:${n.port}`);
    const paid = await asker.payouts.payWithCommittee({
      roundId: c.rid, utxo: c.utxo, contract: c.contract,
      signing: asker.signing, signerNodes: others,
    });
    assert.equal(paid.ok, false);
    assert.equal(paid.committed, SHARES_NEEDED - 1);
    assert.match(paid.why, /4 of 5 signer nodes committed to this spend/);
    assert.equal(asker.round.payout(c.rid).state, PAYOUT_QUEUED, 'a short committee moved the row');
  } finally { await c.close(); }
});

test('a signer node refuses over the wire to sign an output that is not the pool', async () => {
  const c = await committee();
  try {
    const signerNode = c.nodes[1];
    const elsewhere = { ...c.utxo, script: new Uint8Array(34).fill(0x51) };
    const got = await post(signerNode.port, `/pool/commit?round=${toHex(c.rid)}`, encodeUtxo(elsewhere));
    assert.equal(got.status, 409);
    assert.match((await got.text()).trim(), /not the pool this committee holds/);
  } finally { await c.close(); }
});

test('a daemon dealt no share answers the signing doors with a refusal', async () => {
  const c = await committee();
  let shareless;
  try {
    shareless = await serve(openStore(':memory:'), {
      port: 0, ...FUNDED, now: () => NOW, poolKey: c.pool, poolCurve: curve,
    });
    assert.equal((await post(shareless.port, '/round', encodeRoundContract(c.contract))).status, 201);
    const got = await post(shareless.port, `/pool/commit?round=${toHex(c.rid)}`, encodeUtxo(c.utxo));
    assert.equal(got.status, 409);
    assert.match((await got.text()).trim(), /holds no share of the pool/);
  } finally { await c.close(); if (shareless) await shareless.close(); }
});

test('a signer node that committed will not sign a second commitment list over the wire', async () => {
  const c = await committee();
  try {
    const signerNode = c.nodes[1];
    const url = `http://127.0.0.1:${signerNode.port}`;
    const first = await post(signerNode.port, `/pool/commit?round=${toHex(c.rid)}`, encodeUtxo(c.utxo));
    assert.equal(first.status, 200);
    const mine = decodeCommitments(new Uint8Array(await first.arrayBuffer()));

    // Five more signer nodes: four to make a list a real round would carry, and a
    // spare so the second list is a DIFFERENT one rather than a repeat.
    const rest = [];
    for (const n of c.nodes.slice(2, SHARES_NEEDED + 2)) {
      const got = await post(n.port, `/pool/commit?round=${toHex(c.rid)}`, encodeUtxo(c.utxo));
      assert.equal(got.status, 200);
      rest.push(decodeCommitments(new Uint8Array(await got.arrayBuffer()))[0]);
    }
    const list = [...mine, ...rest.slice(0, SHARES_NEEDED - 1)];
    const signed = await post(signerNode.port, `/pool/share?round=${toHex(c.rid)}`,
      encodeShareRequest(c.utxo, list));
    assert.equal(signed.status, 200);

    assert.equal(rest.length, SHARES_NEEDED, 'the fixture did not gather a spare signer node');
    const wider = [...list, rest[SHARES_NEEDED - 1]];
    const again = await post(signerNode.port, `/pool/share?round=${toHex(c.rid)}`,
      encodeShareRequest(c.utxo, wider));
    assert.equal(again.status, 409);
    assert.match((await again.text()).trim(), /will not sign twice/);
  } finally { await c.close(); }
});
