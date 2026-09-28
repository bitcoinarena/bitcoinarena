// AT A LIVE CLOSE, THE PREIMAGE ASK REACHES THE OTHER SIGNER NODES (M3.3-24; the payout gather beside it went with the
// on-chain pool payout, §23.6, RULED 2026-09-25).
//
// Measured on the regtest rehearsal through the real daemons, after M3.3-22:
// the loser's settle on the daemon where its run was final said "1 of 5
// shares: a stake nobody can open stays in flight" with NO peer in the reason
// - it had asked nobody - and both daemons' payout gathers said "1 of 2 signer nodes
// signed this table". `StakeSecrets` and `Payouts` read only the `peers` option,
// which the real launchers never pass. They now take the round's settlement
// committee from the census, the same rule the receipt pull uses; a list the
// operator gave still wins.
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../src/cores.js';
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { Round } from '../src/round.js';
import { Roster } from '../src/roster.js';
import { StakeSecrets } from '../src/stake-secret.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { encodeRoundContract, decodeRoundContract } from '../../protocol/src/contracts.js';
import { toHex } from '../../protocol/src/hash.js';
import { chainOf, FIRST_TIME, SPACING, publicationOf } from '../../protocol/tools/chainview.js';
import { bondTransaction } from '../../protocol/tools/bond.js';
import { deriveCensus } from '../../protocol/src/census.js';
import { parseTransaction } from '../../protocol/src/tx.js';
import { bondSetFor } from '../src/curve.js';
import { bondFor } from './curve.js';
import { beaconFromChain } from '../../protocol/src/beacon.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const FUNDED = { funded: () => true };
const RID = b32(0x42);
const EID = b32(0x43);

/** A fetcher that answers every ask the way a signer node that is not final does. */
function refusingSignerNodes() {
  const asked = [];
  const fetcher = async (url) => {
    asked.push(url);
    return new Response('no share is handed out before the result is final: 1 of 2 agree on any one run', { status: 409 });
  };
  return { asked, fetcher };
}

/** A StakeSecrets whose own share and handout are stood in for - what is measured is who it asks. */
class Asking extends StakeSecrets {
  handoutOf() { return { ok: true, entry: { stakeCommitment: b32(7) }, handout: {} }; }
  async mine() { return { ok: true, share: { signerNode: 1, value: 1n } }; }
}

test('the preimage ask reaches the round\'s census peers when none were given, and the refusal carries the signer node\'s own words', async () => {
  const signerNodes = refusingSignerNodes();
  const round = { pubkey: b32(1) };
  const p = new Asking(round, { peers: [], fetcher: signerNodes.fetcher,
    peersFor: (rid) => (toHex(rid) === toHex(RID) ? ['http://signer-node-b:1'] : []) });
  assert.equal(typeof p.peersOf, 'function', 'the preimage opening has no per-round peer list');
  const opened = await p.open({ roundId: RID, entryId: EID, needed: 2 });
  assert.equal(opened.ok, false);
  assert.equal(signerNodes.asked.length, 1, 'the other signer node was never asked for its share');
  assert.match(signerNodes.asked[0], /^http:\/\/signer-node-b:1\/share\?round=/);
  assert.match(opened.why, /http:\/\/signer-node-b:1: no share is handed out before the result is final/,
    'the refusal is not the other signer node\'s own words');

  // A LIST THE OPERATOR GAVE STILL WINS.
  const given = refusingSignerNodes();
  const q = new Asking(round, { peers: ['http://operator:2'], fetcher: given.fetcher, peersFor: () => ['http://signer-node-b:1'] });
  await q.open({ roundId: RID, entryId: EID, needed: 2 });
  assert.ok(given.asked.every((u) => u.startsWith('http://operator:2/')), `asked ${given.asked}`);
});

// (The payout gather's own census peers went with the on-chain pool payout - §23.6, RULED 2026-09-25.)

// THE DAEMON'S OWN WIRING: a daemon assigned from a census, given no peers.
const HEIGHT = 900000;
const TIP = HEIGHT + 10;
const FROM = HEIGHT - 20;
const advertFor = (key, endpoint) => ({
  nodePubkey: key, operatorId: 'operator', protocolVersions: [1],
  roles: ['game', 'settlement'], endpoint, region: 'eu-west',
  capacityClass: 1, softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: b32(3), guardianOf: [], timestamp: 1788700000000n,
});
const bondOf = (key, n, endpoint) => bondTransaction(advertFor(key, endpoint), {
  previousTxid: b32(0xa0 + n), previousVout: 0, outputKey: bondFor(key),
});
const chainWith = (bonds, contract) => {
  const blocks = [];
  for (let h = FROM; h <= TIP; h++) blocks.push({ transactions: h === FROM ? bonds : [] });
  // AND THE ROUND'S PUBLICATION, well below any beacon (5A.5, v4.6.2): a node
  // signer nodes only a round its own chain shows published before the beacon block.
  if (contract) blocks[1] = { transactions: [publicationOf(contract)] };
  return chainOf(blocks, FROM);
};
const contractFor = (nodes, censusRoot) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: TRUCK_CORE_HASH,
  committeeTimeMs: BigInt(FIRST_TIME + 15 * SPACING) * 1000n,
  startTimeMs: BigInt(FIRST_TIME + 15 * SPACING) * 1000n + 60500n,
  entryCloseMs: BigInt(FIRST_TIME + 15 * SPACING) * 1000n + 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: HEIGHT, censusRoot, randomnessRule: 'bitcoin-block-hash',
  stakeMsat: 0n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40,
  spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
});

test('a daemon given no peers asks the other settlement signer node, off the census, for its share', async () => {
  const a = await serve(openStore(':memory:'), { port: 0, ...FUNDED });
  const b = await serve(openStore(':memory:'), { port: 0, ...FUNDED });
  try {
    const keys = [a.round.pubkey, b.round.pubkey];
    const bonds = [bondOf(keys[0], 1, `ws://127.0.0.1:${a.port}`), bondOf(keys[1], 2, `ws://127.0.0.1:${b.port}`)];
    const view = chainWith(bonds);
    const byTxid = new Map();
    for (const block of view.blocks)
      for (const raw of block.transactions) byTxid.set(toHex(parseTransaction(raw).txid), raw);
    const census = deriveCensus(view, {
      contract: decodeRoundContract(encodeRoundContract(contractFor(keys, b32(2)))), bond: bondSetFor('regtest'),
      resolve: (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; },
    });
    assert.equal(census.ok, true, census.why);
    const c = contractFor(keys, census.root);
    const published = chainWith(bonds, c);
    const named = beaconFromChain(c, { headers: published.blocks.map((x) => x.header), firstHeight: published.firstHeight });
    const beacon = { hash: named.hash, height: named.height, timeMs: named.timeMs };
    const storeA = a.round.db;
    await a.close();
    const again = await serve(storeA, { port: a.port, ...FUNDED, chainFor: () => published, randomnessFor: () => beacon });
    try {
      const rid = again.round.open(c);
      const joined = new Roster(again.round, { chainFor: () => published, randomnessFor: () => beacon }).assignSignerNodes(rid);
      assert.equal(joined.ok, true, joined.why);
      const other = [`http://127.0.0.1:${b.port}`];
      assert.deepEqual(again.stakeSecrets.peersOf(rid), other, 'the preimage ask does not reach the other settlement signer node');
    } finally { await again.close(); }
  } finally { await b.close(); }
});
