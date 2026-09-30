#!/usr/bin/env node
// A PUBLISHED ROUND FIRST, ITS BEACON AFTER - MEASURED ON A PRIVATE REGTEST (the owner 2026-09-30, pick (b), the sequence):
//   1. publication unconfirmed: no beacon is named, and the wait does not end on it;
//   2. only once the publication confirms is the beacon named (strictly above it);
//   3. a confirm that lands after the beacon block - the fcb15cca shape - is not a published round: `dead`, not forced;
//   4. fee path: an unconfirmed publication is fee-raised (bumpfee), then confirms, and only then is the beacon named.
// Its own bitcoind (RT datadir, RPCPORT 30601), blocks ten minutes apart on a mock clock (testnet4's pace), mined one
// at a time WITHOUT the publication (generateblock with no transactions) until the step says to let it in. The wait is
// the runner's own (src/publication-wait.js), fed this chain's view; its sleep is where the next block is made.
//
//   RT=<datadir> RPCPORT=30601 node tools/publication-regtest.mjs      (from packages/blwp-node)
import { bitcoindRpc, blocksOver } from '../src/chain-rpc.js';
import { awaitPublishedBeacon, beaconBlockIn } from '../src/publication-wait.js';
import { publicationPayload } from '../../protocol/src/publication.js';
import { encodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { blockTimeOf } from '../../protocol/src/chain.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../src/cores.js';
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';
import { toHex } from '../../protocol/src/hash.js';

const env = process.env;
const RT = env.RT; const PORT = env.RPCPORT || '30601';
if (!RT) throw new Error('RT=<a private regtest datadir>');
const node = bitcoindRpc({ url: `http://127.0.0.1:${PORT}`, cookiePath: `${RT}/regtest/.cookie` });
const w = bitcoindRpc({ url: `http://127.0.0.1:${PORT}/wallet/p`, cookiePath: `${RT}/regtest/.cookie` });
const out = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const b32 = (n) => new Uint8Array(32).fill(n);

const tipHeight = async () => Number(await node('getblockcount', []));
let clock = 0;
const addr = await w('getnewaddress', []);
// ONE BLOCK, TEN MINUTES AFTER THE LAST, carrying only what `txs` names (none: the publication stays out).
const block = async (txs = []) => { clock += 600; await node('setmocktime', [clock]); return node('generateblock', [addr, txs]); };
const mempoolHas = async (txid) => { try { await node('getmempoolentry', [txid]); return true; } catch { return false; } };
const FROM = async () => Math.max(0, (await tipHeight()) - 40);
let from = 0;
const view = async () => blocksOver(node, from, await tipHeight());

function draft(committeeTimeMs, n) {
  return { networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 2, settlementSlots: 2,
    simCoreHash: TRUCK_CORE_HASH, committeeTimeMs, randomnessRule: 'bitcoin-block-hash', startTimeMs: committeeTimeMs + 60000n,
    entryCloseMs: committeeTimeMs + 1860000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
    federationId: b32(5), stakeExpiryBlocks: 144, publicationRelays: ['http://127.0.0.1:1'], donationSetId: b32(6), censusHeight: 1,
    censusRoot: b32(n), stakeMsat: 0n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40,
    spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(7), b32(8)] };
}
// THE RUNNER'S OWN PUBLICATION: OP_RETURN "BLW" ROUND || round id, 2 sat/vB, replaceable - broadcast, not mined.
async function publish(c) {
  const raw = await w('createrawtransaction', [[], [{ data: toHex(publicationPayload(roundId(c))) }]]);
  const paid = (await w('fundrawtransaction', [raw, { fee_rate: 2, replaceable: true }])).hex;
  return w('sendrawtransaction', [(await w('signrawtransactionwithwallet', [paid])).hex]);
}
async function committeeNow() {
  const h = await tipHeight();
  const hdr = (await blocksOver(node, h, h)).blocks[0].header;
  return (BigInt(blockTimeOf(hdr)) + 2n) * 1000n;           // the runner's rule: just past the tip's own timestamp
}

// ---- a funded wallet (at the real clock), then a chain with a clock: 30 blocks ten minutes apart, from now on
await w('generatetoaddress', [110, addr]);
clock = Math.floor(Date.now() / 1000);
for (let i = 0; i < 30; i++) await block();

// ---- steps 1, 2, 4: unconfirmed -> fee raised -> confirms -> only then the beacon
{
  const c = draft(await committeeNow(), 11);
  from = await FROM();
  const txid = await publish(c);
  const looks = [];
  const whileUnconfirmed = [];
  let letIn = false;
  const got = await awaitPublishedBeacon({ contract: c, txid, rpc: w, view, sleepMs: 0, maxLooks: 60, log: (s) => looks.push(s),
    sleep: async () => {
      const v = await view();
      const confirmedYet = letIn;
      // WHILE IT IS UNCONFIRMED the wait has not returned - it is here, asking for the next block - and names no beacon.
      if (!confirmedYet) whileUnconfirmed.push({ tip: v.firstHeight + v.blocks.length - 1, beaconBlockYet: beaconBlockIn(c, v) });
      const raises = looks.filter((l) => /fee raised/.test(l)).length;
      // THE PUBLICATION STAYS OUT until its fee has been raised twice; then the next block carries the raised one.
      if (raises >= 2 && !letIn) { letIn = true; await block(await node('getrawmempool', [])); }
      else await block();
    } });
  const beaconAt = got.named ? got.named.height : null;
  out({ step: '1, 2, 4', round: toHex(roundId(c)).slice(0, 16), firstTxid: txid.slice(0, 16), ok: got.ok, publishedAt: got.publishedAt,
    beaconNamed: beaconAt, beaconAbovePublication: beaconAt !== null && beaconAt > got.publishedAt, feeRaises: looks.filter((l) => /fee raised/.test(l)),
    whileUnconfirmed, finalTxid: String(got.txid).slice(0, 16), originalStillInMempool: await mempoolHas(txid) });
}

// ---- step 3: the beacon block comes first, the publication confirms after it - the fcb15cca shape
{
  const c = draft(await committeeNow(), 12);
  from = await FROM();
  const txid = await publish(c);
  // No fee raise here: the publication is kept out of every block up to and past its beacon block, whatever it pays.
  let beaconBlock = null;
  for (let i = 0; i < 20 && beaconBlock === null; i++) { await block(); beaconBlock = beaconBlockIn(c, await view()); }
  // STILL UNCONFIRMED, AND THE BEACON BLOCK IS HERE: dead already.
  const before = await awaitPublishedBeacon({ contract: c, txid, rpc: w, view, sleepMs: 0, maxLooks: 1, log: () => {}, sleep: async () => {} });
  out({ step: '3a', round: toHex(roundId(c)).slice(0, 16), beaconBlock, publishedAt: before.publishedAt, dead: !!before.dead, why: before.why });
  const pool = await node('getrawmempool', []);
  await block(pool);                                         // it confirms now - after the beacon block
  const got = await awaitPublishedBeacon({ contract: c, txid, rpc: w, view, sleepMs: 0, maxLooks: 5, log: () => {}, sleep: async () => block() });
  out({ step: '3b', round: toHex(roundId(c)).slice(0, 16), beaconBlock, publishedAt: got.publishedAt, ok: got.ok, dead: !!got.dead, why: got.why });
}
await node('setmocktime', [0]);
out({ step: 'done', tip: await tipHeight() });
void encodeRoundContract;
