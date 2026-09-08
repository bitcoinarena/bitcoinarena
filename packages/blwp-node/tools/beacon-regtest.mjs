#!/usr/bin/env node
/**
 * THE COMMITTEE BEACON, READ OFF A REAL CHAIN.
 *
 *   RT=<datadir> node tools/beacon-regtest.mjs      (from packages/blwp-node)
 *
 * An ISOLATED regtest of your own - its own datadir, its own port, its own
 * wallet. It touches no mainnet and no testnet datadir, and it is not the
 * daemon the 2-of-2 runs against:
 *
 *   bitcoind -regtest -datadir=DIR -port=29644 -rpcport=29643 -fallbackfee=0.0001 -daemon
 *
 * What it proves is the thing that was missing: `beaconFromChain` already says
 * WHICH block seeds a committee, and until now the headers it judged were
 * headers a caller wrote. These come from bitcoind. No second chooser is
 * added - the rule is the same function, and this only feeds it.
 */
import { execFileSync } from 'node:child_process';
import { bitcoindRpc, headersToTip } from '../src/chain-rpc.js';
import { beaconFromChain, beaconIsTheChains, medianTimePast,
  committeeSeedFromBeacon, MEDIAN_TIME_SPAN } from '../../protocol/src/beacon.js';
import { blockHashOf, blockTimeOf } from '../../protocol/src/chain.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { toHex } from '../../protocol/src/hash.js';

const RT = process.env.RT;
if (!RT) { console.error('RT=<datadir> is required'); process.exit(2); }
const B = process.env.BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli';
const PORT = process.env.RPCPORT || '29643';
const cli = (...a) =>
  execFileSync(B, ['-regtest', `-datadir=${RT}`, `-rpcport=${PORT}`, ...a], { encoding: 'utf8' }).trim();

const b32 = (n) => new Uint8Array(32).fill(n);
const say = (label, value) => console.log(`  ${label.padEnd(42)} ${value}`);

// A chain deep enough for an eleven-block median and a confirmation depth.
const WANT = 40;
let height = Number(cli('getblockcount'));
if (height < WANT) {
  try { cli('createwallet', 'beacon'); } catch { cli('loadwallet', 'beacon'); }
  cli('generatetoaddress', String(WANT - height), cli('getnewaddress'));
  height = Number(cli('getblockcount'));
}
console.log(`regtest at height ${height}, datadir ${RT}`);

const call = bitcoindRpc({
  url: `http://127.0.0.1:${PORT}/`,
  cookiePath: `${RT}/regtest/.cookie`,
});

const window = await headersToTip(call, { count: 25 });
say('headers read from bitcoind', `${window.headers.length}, heights `
  + `${window.firstHeight}..${window.tipHeight}`);

// COMMITTEE TIME IS SET FROM THE CHAIN'S OWN CLOCK, at the median of a block
// in the middle of the window, so the answer is a block further along and the
// arithmetic is checkable by hand.
const at = window.firstHeight + MEDIAN_TIME_SPAN + 2;
const committeeTimeMs = BigInt(medianTimePast(window.headers, window.firstHeight, at)) * 1000n;
const contract = {
  networkId: NETWORK_ID_REGTEST,
  committeeTimeMs,
  censusConfirmations: 6,
  censusRoot: b32(2),
  randomnessRule: 'bitcoin-block-hash',
};
say('committee_time set to the median at', `${at} (${committeeTimeMs} ms)`);

const one = beaconFromChain(contract, window);
if (!one.ok) { console.error('  REFUSED: ' + one.why); process.exit(1); }
say('the chain names block', `${one.height}, ${one.depth} deep`);
say('its hash', toHex(one.hash));
say('its median time past', `${one.timeMs} ms`);
say('its own header time', `${BigInt(blockTimeOf(window.headers[one.height - window.firstHeight])) * 1000n} ms`);

// TWICE, from bitcoind, not from the copy in memory: two reads of one chain
// have to name one block, or nodes cannot agree on who sat.
const again = await headersToTip(call, { count: 25 });
const two = beaconFromChain(contract, again);
say('a second read names', `${two.height} ${toHex(two.hash).slice(0, 16)}...`);
say('same block twice', String(one.height === two.height && toHex(one.hash) === toHex(two.hash)));

const seedOne = committeeSeedFromBeacon(contract, {
  roundId: b32(9), randomness: one.hash, height: one.height, timeMs: one.timeMs });
const seedTwo = committeeSeedFromBeacon(contract, {
  roundId: b32(9), randomness: two.hash, height: two.height, timeMs: two.timeMs });
say('committee seed', toHex(seedOne.seed));
say('same seed twice', String(toHex(seedOne.seed) === toHex(seedTwo.seed)));

// AND THE REFUSALS, against the same real chain.
const later = {
  height: one.height + 1,
  hash: blockHashOf(window.headers[one.height + 1 - window.firstHeight]),
  timeMs: BigInt(medianTimePast(window.headers, window.firstHeight, one.height + 1)) * 1000n,
};
say('a later real block is', beaconIsTheChains(contract, later, window).why);
say('too shallow is', beaconFromChain({ ...contract, censusConfirmations: 100 }, window).why);
say('a short window is', beaconFromChain(contract,
  { headers: window.headers.slice(0, 9), firstHeight: window.firstHeight }).why);

console.log('\nstop the daemon when you are done:');
console.log(`  ${B.replace('bitcoin-cli', 'bitcoin-cli')} -regtest -datadir=${RT} -rpcport=${PORT} stop`);
