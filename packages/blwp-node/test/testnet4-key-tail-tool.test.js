// THE TESTNET4 TAIL THAT PAYS ITS DONATION IN THE FEDERATION, DRY AND OFF THE CHAIN (kanban #148, plan comment 222):
// tools/testnet4-key-tail.mjs as it is run, against the fake bitcoin-cli, a fake signer node listing one paid round, and a fake
// bitcoind JSON-RPC serving a chain of linked coinbase-only blocks for its census (no bonds: an empty census). A dry run writes
// key-tail-<id>-dry.json - the live round carried forward with testnet4's set of keys as its donation set and the census at
// the tip less 2 - and never sends; a census below the set's valid_from, or a wallet of a bond and a marker, is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTool } from './tn4-tool-harness.js';
import { encodeRoundContract, decodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { genesisSeriesStart, ROUND_PERIOD_MS, LATE_JOIN_MS } from '../../protocol/src/series.js';
import { NETWORK_ID_TESTNET4 } from '../../protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { TESTNET4_DONATION_SET_KEYS as KEYS } from '../../protocol/src/testnet4-donation-set-keys.js';
import { donationSetId } from '../../protocol/src/donation.js';
import { blockOf } from '../../protocol/tools/bond.js';
import { hash256, parseTransaction } from '../../protocol/src/tx.js';
import { blockHashOf } from '../../protocol/src/chain.js';
import { NEXTBLOCK_GAME_ID } from '../../core/plugin/nextblock.js';

const TOOL = new URL('../tools/testnet4-key-tail.mjs', import.meta.url).pathname;
const b32 = (n) => new Uint8Array(32).fill(n);
const hex = (b) => Buffer.from(b).toString('hex');
const H = KEYS.validFrom + 100;                                     // the census: tip (H + 2) less 2
const coinbase = (h) => Uint8Array.from([1, 0, 0, 0, 1, ...new Uint8Array(32), 0xff, 0xff, 0xff, 0xff, 4, 3, h & 255, (h >> 8) & 255, (h >> 16) & 255,
  0xff, 0xff, 0xff, 0xff, 1, ...new Uint8Array(8), 1, 0x51, 0, 0, 0, 0]);
// a chain of linked blocks from H - 2016, each one coinbase
const BLOCKS = new Map();
{ let prev = new Uint8Array(32);
  for (let h = H - 2030; h <= H + 2; h++) { const tx = coinbase(h); const { header } = blockOf(hash256, [parseTransaction(tx).txid], { previous: prev }); prev = blockHashOf(header); BLOCKS.set(h, Uint8Array.from([...header, 1, ...tx])); } }
async function bitcoind() {
  const srv = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { const { method, params } = JSON.parse(b);
    const result = method === 'getblockhash' ? `hash${params[0]}` : method === 'getblock' ? hex(BLOCKS.get(Number(String(params[0]).slice(4)))) : null;
    res.end(JSON.stringify({ result, error: result === null ? { message: `no ${method}` } : null, id: 'blwp' })); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'tn4-cookie-'));
  writeFileSync(join(dir, '.cookie'), '__cookie__:test');
  return { env: { BLWP_TN4_RPC: `http://127.0.0.1:${srv.address().port}`, BLWP_TN4_COOKIE: join(dir, '.cookie') }, close: () => new Promise((r) => srv.close(r)) };
}
const LIVE = {
  networkId: NETWORK_ID_TESTNET4, configHash: b32(1), censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(9),
  committeeTimeMs: 1000n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 100000n, entryCloseMs: 100000n, objectionWindowMs: 600000n,
  custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144,
  publicationRelays: ['wss://r.example'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 150000, censusRoot: b32(2),
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: Array.from({ length: 7 }, (_, i) => b32(0x40 + i)),
};
const RID = hex(roundId(LIVE));
const START = genesisSeriesStart(NETWORK_ID_TESTNET4) + 20n * 86400000n + 200n * ROUND_PERIOD_MS;
const UTXOS = [
  { txid: 'b'.repeat(64), vout: 0, amount: 50000 / 1e8, spendable: true, solvable: true },
  { txid: 'c'.repeat(64), vout: 1, amount: 1670 / 1e8, spendable: true, solvable: true },
  { txid: 'e'.repeat(64), vout: 3, amount: 12000 / 1e8, spendable: true, solvable: true },
];
const SPEC = { mtp: {}, tip: { blocks: H + 2, mediantime: Number((START - 48n * 3600000n) / 1000n) }, utxos: UTXOS, input: { txid: 'e'.repeat(64), vout: 3 }, mempool: { allowed: true }, send: 'a'.repeat(64) };
const ROUTES = { '/rounds?next=4': { rounds: [{ id: RID, free: false }] }, [`/round?id=${RID}`]: encodeRoundContract(LIVE) };
async function run(spec, { extra = [], env = {} } = {}) {
  const chain = await bitcoind();
  try { return await runTool(TOOL, { spec, routes: ROUTES, env: { ...chain.env, ...env }, args: (url, dir) => [url, new Date(Number(START)).toISOString(), dir, ...extra] }); }
  finally { await chain.close(); }
}

test('a dry run writes the key tail: the live round, testnet4\'s set of keys, the census at the tip less 2, and broadcasts nothing', async () => {
  const r = await run(SPEC);
  assert.equal(r.code, 0, r.stderr);
  const name = Object.keys(r.files).find((f) => /^key-tail-[0-9a-f]{16}-dry\.json$/.test(f));
  assert.ok(name, `no dry record: ${Object.keys(r.files)}`);
  const rec = JSON.parse(r.files[name]);
  const t = decodeRoundContract(Uint8Array.from(Buffer.from(rec.template, 'hex')));
  assert.equal(hex(t.donationSetId), hex(donationSetId(KEYS.recipients)), 'the tail does not name the set of keys');
  assert.equal(t.censusHeight, H);
  assert.equal(t.startTimeMs, START);
  assert.equal(t.entryCloseMs, START + LATE_JOIN_MS);
  assert.equal(hex(t.federationId), hex(LIVE.federationId));
  assert.ok(!r.methods.includes('sendrawtransaction'), 'a dry run sent');
  assert.deepEqual(JSON.parse(r.calls.find((c) => c.method === 'createrawtransaction').params[0]), [{ txid: 'e'.repeat(64), vout: 3 }]);
  assert.match(r.stdout, /"step":"census","height":\d+,"root":"[0-9a-f]{64}","entries":0/);
});

test('an explicit committee time is taken; a census below the set\'s valid_from and a wallet of a bond and a marker are refused', async () => {
  const at = START - 36n * 3600000n;
  const c = await run(SPEC, { env: { COMMITTEE_AT_MS: String(at) } });
  assert.equal(c.code, 0, c.stderr);
  const rec = JSON.parse(c.files[Object.keys(c.files).find((f) => f.endsWith('-dry.json'))]);
  assert.equal(rec.committeeTimeMs, String(at));
  const low = await run(SPEC, { env: { CENSUS_HEIGHT: String(KEYS.validFrom - 1) } });
  assert.notEqual(low.code, 0);
  assert.match(low.stderr, new RegExp(`census ${KEYS.validFrom - 1} is below the set of keys' valid_from ${KEYS.validFrom}`));
  const bonds = await run({ ...SPEC, utxos: UTXOS.slice(0, 2) }, { extra: ['--send'] });
  assert.notEqual(bonds.code, 0);
  assert.match(bonds.stderr, /no non-bond output of 5000 sat or more/);
  assert.ok(!bonds.methods.includes('createrawtransaction') && !bonds.methods.includes('sendrawtransaction'));
});
