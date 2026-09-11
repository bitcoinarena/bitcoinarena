// AT A LIVE CLOSE, THE PREIMAGE ASK AND THE PAYOUT GATHER REACH THE OTHER SEATS (M3.3-24).
//
// Measured on the regtest rehearsal through the real daemons, after M3.3-22:
// the loser's settle on the daemon where its run was final said "1 of 5
// shares: a stake nobody can open stays in flight" with NO peer in the reason
// - it had asked nobody - and both daemons' payout gathers said "1 of 2 seats
// signed this table". `Preimages` and `Payouts` read only the `peers` option,
// which the real launchers never pass. They now take the round's settlement
// committee from the census, the same rule the receipt pull uses; a list the
// operator gave still wins.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { Round } from '../src/round.js';
import { Roster } from '../src/roster.js';
import { Preimages } from '../src/preimage.js';
import { Payouts } from '../src/payout.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { encodeRoundContract, decodeRoundContract } from '../../protocol/src/contracts.js';
import { toHex } from '../../protocol/src/hash.js';
import { chainOf, FIRST_TIME, SPACING } from '../../protocol/tools/chainview.js';
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

/** A fetcher that answers every ask the way a seat that is not final does. */
function refusingSeats() {
  const asked = [];
  const fetcher = async (url) => {
    asked.push(url);
    return new Response('no share is handed out before the result is final: 1 of 2 agree on any one run', { status: 409 });
  };
  return { asked, fetcher };
}

/** A Preimages whose own share and handout are stood in for - what is measured is who it asks. */
class Asking extends Preimages {
  handoutOf() { return { ok: true, entry: { stakeCommitment: b32(7) }, handout: {} }; }
  async mine() { return { ok: true, share: { seat: 1, value: 1n } }; }
}

test('the preimage ask reaches the round\'s census peers when none were given, and the refusal carries the seat\'s own words', async () => {
  const seats = refusingSeats();
  const round = { pubkey: b32(1) };
  const p = new Asking(round, { peers: [], fetcher: seats.fetcher,
    peersFor: (rid) => (toHex(rid) === toHex(RID) ? ['http://seat-b:1'] : []) });
  assert.equal(typeof p.peersOf, 'function', 'the preimage opening has no per-round peer list');
  const opened = await p.open({ roundId: RID, entryId: EID, needed: 2 });
  assert.equal(opened.ok, false);
  assert.equal(seats.asked.length, 1, 'the other seat was never asked for its share');
  assert.match(seats.asked[0], /^http:\/\/seat-b:1\/share\?round=/);
  assert.match(opened.why, /http:\/\/seat-b:1: no share is handed out before the result is final/,
    'the refusal is not the other seat\'s own words');

  // A LIST THE OPERATOR GAVE STILL WINS.
  const given = refusingSeats();
  const q = new Asking(round, { peers: ['http://operator:2'], fetcher: given.fetcher, peersFor: () => ['http://seat-b:1'] });
  await q.open({ roundId: RID, entryId: EID, needed: 2 });
  assert.ok(given.asked.every((u) => u.startsWith('http://operator:2/')), `asked ${given.asked}`);
});

test('the payout gather asks the round\'s census peers for the table signatures when none were given', async () => {
  const asked = [];
  const round = { putPayoutSignature() {} };
  const pay = new Payouts(round, { peers: [], fetcher: async (url) => { asked.push(url); return new Response('', { status: 404 }); },
    peersFor: (rid) => (toHex(rid) === toHex(RID) ? ['http://seat-b:1'] : []) });
  assert.equal(typeof pay.peersOf, 'function', 'the payout path has no per-round peer list');
  const got = await pay.gather({ roundId: RID });
  assert.deepEqual(asked, [`http://seat-b:1/payout?round=${toHex(RID)}`], 'the other seat was not asked for its signature');
  assert.equal(got.refused, 1);

  const given = [];
  const q = new Payouts(round, { peers: ['http://operator:2'], fetcher: async (u) => { given.push(u); return new Response('', { status: 404 }); },
    peersFor: () => ['http://seat-b:1'] });
  await q.gather({ roundId: RID });
  assert.deepEqual(given, [`http://operator:2/payout?round=${toHex(RID)}`], 'a given peers list was replaced');
});

// THE DAEMON'S OWN WIRING: a daemon seated from a census, given no peers.
const HEIGHT = 900000;
const TIP = HEIGHT + 10;
const FROM = HEIGHT - 20;
const advertFor = (key, endpoint) => ({
  nodePubkey: key, operatorId: 'operator', protocolVersions: [1],
  roles: ['game', 'settlement'], endpoint, region: 'eu-west',
  capacityClass: 1, softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: b32(3), timestamp: 1788700000000n,
});
const bondOf = (key, n, endpoint) => bondTransaction(advertFor(key, endpoint), {
  previousTxid: b32(0xa0 + n), previousVout: 0, outputKey: bondFor(key),
});
const chainWith = (bonds) => {
  const blocks = [];
  for (let h = FROM; h <= TIP; h++) blocks.push({ transactions: h === FROM ? bonds : [] });
  return chainOf(blocks, FROM);
};
const contractFor = (nodes, censusRoot) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: b32(1),
  committeeTimeMs: BigInt(FIRST_TIME + 15 * SPACING) * 1000n,
  startTimeMs: BigInt(FIRST_TIME + 15 * SPACING) * 1000n + 60500n,
  entryCloseMs: BigInt(FIRST_TIME + 15 * SPACING) * 1000n + 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [],
  donationSetId: b32(0xd0), censusHeight: HEIGHT, censusRoot, randomnessRule: 'bitcoin-block-hash',
  stakeMsat: 0n, bondMinSats: 50000n, blockTicks: 9000, exposureReference: 1000, corridorHalfWidth: 40,
  spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
});

test('a daemon given no peers asks the other settlement seat, off the census, for its share and its table signature', async () => {
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
    const named = beaconFromChain(c, { headers: view.blocks.map((x) => x.header), firstHeight: view.firstHeight });
    const beacon = { hash: named.hash, height: named.height, timeMs: named.timeMs };
    const storeA = a.round.db;
    await a.close();
    const again = await serve(storeA, { port: a.port, ...FUNDED, chainFor: () => view, randomnessFor: () => beacon });
    try {
      const rid = again.round.open(c);
      const seated = new Roster(again.round, { chainFor: () => view, randomnessFor: () => beacon }).seatRound(rid);
      assert.equal(seated.ok, true, seated.why);
      const other = [`http://127.0.0.1:${b.port}`];
      assert.deepEqual(again.preimages.peersOf(rid), other, 'the preimage ask does not reach the other settlement seat');
      assert.deepEqual(again.payouts.peersOf(rid), other, 'the payout gather does not reach the other settlement seat');
    } finally { await again.close(); }
  } finally { await b.close(); }
});
