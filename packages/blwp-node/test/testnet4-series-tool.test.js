// THE TOOL THAT POSTS A ROUND SERIES ON TESTNET4, DRY AND OFF THE CHAIN (kanban #148, plan comment 222, Go 2026-10-05):
// tools/testnet4-series.mjs run as it is run, as a child process, against a FAKE bitcoin-cli (test/fake-bitcoin-cli.mjs: every
// call logged, every answer scripted) and a fake signer node serving the round. No node, no wallet, no testnet4 is touched.
// The record it writes and every call it made are read back: the series and its publication, one wallet output and never
// a bond (50 000 sat) or a marker (1 670 sat), and no sendrawtransaction without --send.
//
// Read from the source before this file, and measured here first: the tool named `start` (lines 62, 81), which nothing
// declares since 04c5ecec - it threw "start is not defined" before it wrote even a dry record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { seriesTemplate, seriesIndexAt, seriesId, seriesPublicationPayload, seriesClockFor } from '../../protocol/src/series.js';
import { NETWORK_ID_TESTNET4 } from '../../protocol/src/genesis-ids.js';
import { genesisSeriesStart } from '../../protocol/src/series.js';
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId } from '../../protocol/src/donation.js';

const TOOL = new URL('../tools/testnet4-series.mjs', import.meta.url).pathname;
const FAKE = new URL('./fake-bitcoin-cli.mjs', import.meta.url).pathname;
const b32 = (n) => new Uint8Array(32).fill(n);
const hex = (b) => Buffer.from(b).toString('hex');
const H = 150000;
const LIVE = {
  networkId: NETWORK_ID_TESTNET4, configHash: b32(1), censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7,
  simCoreHash: b32(9), committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 0n, entryCloseMs: 0n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: H, censusRoot: b32(2),
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: Array.from({ length: 7 }, (_, i) => b32(0x40 + i)),
};
const RID = hex(roundId(LIVE));
// the census block H, ten days into the network's series clock; series k is the first whose census cut is at or after it
const { censusLeadMs } = seriesClockFor(NETWORK_ID_TESTNET4);
const MTP_H = genesisSeriesStart(NETWORK_ID_TESTNET4) + 10n * 86400000n + 3600000n;
const K = seriesIndexAt(NETWORK_ID_TESTNET4, MTP_H + censusLeadMs);
const TEMPLATE = seriesTemplate(LIVE, K);
const CUT = TEMPLATE.startTimeMs - censusLeadMs;
const sats = (n) => n / 1e8;
const UTXOS = [
  { txid: 'b'.repeat(64), vout: 0, amount: sats(50000), spendable: true, solvable: true },      // a bond
  { txid: 'c'.repeat(64), vout: 1, amount: sats(1670), spendable: true, solvable: true },       // a marker
  { txid: 'd'.repeat(64), vout: 2, amount: sats(80000), spendable: true, solvable: true },
  { txid: 'e'.repeat(64), vout: 3, amount: sats(12000), spendable: true, solvable: true },      // the smallest non-bond: chosen
  { txid: '9'.repeat(64), vout: 4, amount: sats(3000), spendable: true, solvable: true },       // under 5000 sat
];
const SPEC = {
  mtp: { [H]: Number(MTP_H / 1000n), [H + 1]: Number(CUT / 1000n) + 600 },
  tip: { blocks: H + 10, mediantime: Number(MTP_H / 1000n) + 3600 },
  utxos: UTXOS, input: { txid: 'e'.repeat(64), vout: 3 }, mempool: { allowed: true }, send: 'a'.repeat(64),
};

async function run(spec, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), 'tn4-series-'));
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec));
  const srv = createServer((req, res) => {
    if (req.url === `/round?id=${RID}`) { res.writeHead(200); return res.end(Buffer.from(encodeRoundContract(LIVE))); }
    res.writeHead(404); res.end('no such round');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const env = { ...process.env, BLWP_BITCOIN_CLI: FAKE, BLWP_TN4_DATADIR: '/nonexistent', BLWP_TN4_WALLET: 'test', FAKE_CLI_SPEC: join(dir, 'spec.json'), FAKE_CLI_LOG: join(dir, 'calls.jsonl') };
  const got = await new Promise((done) => execFile(process.execPath, [TOOL, `http://127.0.0.1:${srv.address().port}`, RID, dir, ...extra], { env, timeout: 60000 },
    (err, stdout, stderr) => done({ code: err ? err.code || 1 : 0, stdout, stderr })));
  await new Promise((r) => srv.close(r));
  const calls = existsSync(join(dir, 'calls.jsonl')) ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const file = join(dir, `series-${hex(seriesId(TEMPLATE)).slice(0, 16)}.json`);
  return { ...got, calls, methods: calls.map((c) => c.method), record: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null };
}

test('a dry run writes the series and its signed publication, spends one non-bond output, and broadcasts nothing', async () => {
  const r = await run(SPEC);
  assert.equal(r.code, 0, `the tool failed: ${r.stderr}`);
  assert.ok(r.record, 'no series record was written');
  assert.equal(r.record.series, hex(seriesId(TEMPLATE)));
  assert.equal(r.record.seriesStartMs, String(TEMPLATE.startTimeMs));
  assert.equal(r.record.committeeTimeMs, String(TEMPLATE.committeeTimeMs));
  assert.equal(r.record.payload, hex(seriesPublicationPayload(seriesId(TEMPLATE))));
  assert.equal(r.record.censusHeight, H);
  assert.equal(r.record.broadcast, false);
  assert.match(r.record.hex, /^signed:funded:raw:/);
  assert.ok(!r.methods.includes('sendrawtransaction'), 'a dry run called sendrawtransaction');
  // the one input: the smallest output that is not a bond, not a marker and at least 5000 sat
  const create = r.calls.find((c) => c.method === 'createrawtransaction');
  assert.deepEqual(JSON.parse(create.params[0]), [{ txid: 'e'.repeat(64), vout: 3 }]);
  assert.deepEqual(JSON.parse(create.params[1]), [{ data: r.record.payload }]);
  const fund = r.calls.find((c) => c.method === 'fundrawtransaction');
  assert.equal(JSON.parse(fund.params[1]).add_inputs, false, 'the wallet may add inputs - a bond among them');
});

test('a wallet with only a bond and a marker is refused by name; nothing is built, signed or sent', async () => {
  const r = await run({ ...SPEC, utxos: UTXOS.slice(0, 2).concat(UTXOS[4]) }, ['--send']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no confirmed non-bond output of at least 5000 sat in the wallet/);
  for (const m of ['createrawtransaction', 'fundrawtransaction', 'signrawtransactionwithwallet', 'sendrawtransaction'])
    assert.ok(!r.methods.includes(m), `${m} was called`);
  assert.equal(r.record, null);
});

test('a publication that spends another output than the one chosen is refused, and nothing is sent', async () => {
  const r = await run({ ...SPEC, input: { txid: 'b'.repeat(64), vout: 0 } }, ['--send']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /the publication spends something other than the one output chosen/);
  assert.ok(!r.methods.includes('sendrawtransaction'));
});

test('--send broadcasts once, after the mempool accepts it; a refused publication is not sent', async () => {
  const sent = await run(SPEC, ['--send']);
  assert.equal(sent.code, 0, sent.stderr);
  assert.equal(sent.methods.filter((m) => m === 'sendrawtransaction').length, 1);
  assert.deepEqual({ broadcast: sent.record.broadcast, txid: sent.record.txid }, { broadcast: true, txid: 'a'.repeat(64) });
  const refused = await run({ ...SPEC, mempool: { allowed: false, reason: 'min relay fee not met' } }, ['--send']);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /the mempool refuses the publication: min relay fee not met/);
  assert.ok(!refused.methods.includes('sendrawtransaction'));
});
