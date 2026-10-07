// THE TESTNET4 LATE-JOIN TAIL, DRY AND OFF THE CHAIN (kanban #148, plan comment 222): tools/testnet4-late-tail.mjs as it is
// run, against the fake bitcoin-cli and a fake signer node listing one paid round. A dry run writes late-tail-<id>-dry.json -
// the tail's template from that round, rounds every 90 s from its start to its day's end, entry closing 45 s after each start,
// committee 12 h before - and never calls sendrawtransaction; a bond (50 000 sat) or a marker (1 670 sat) is never its input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTool } from './tn4-tool-harness.js';
import { encodeRoundContract, decodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { genesisSeriesStart, seriesId, seriesPublicationPayload, ROUND_PERIOD_MS, ROUNDS_PER_SERIES, LATE_JOIN_MS, TAIL_COMMITTEE_LEAD_MIN_MS } from '../../protocol/src/series.js';
import { NETWORK_ID_TESTNET4 } from '../../protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId } from '../../protocol/src/donation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const TOOL = new URL('../tools/testnet4-late-tail.mjs', import.meta.url).pathname;
const b32 = (n) => new Uint8Array(32).fill(n);
const hex = (b) => Buffer.from(b).toString('hex');
const LIVE = {
  networkId: NETWORK_ID_TESTNET4, configHash: b32(1), censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(9), committeeTimeMs: 1000n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 100000n, entryCloseMs: 100000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID,
  stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 150000, censusRoot: b32(2), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000,
  corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: Array.from({ length: 7 }, (_, i) => b32(0x40 + i)),
};
const RID = hex(roundId(LIVE));
// the tail starts at round 200 of a day twenty days into the network's series clock
const DAY = genesisSeriesStart(NETWORK_ID_TESTNET4) + 20n * 86400000n;
const START = DAY + 200n * ROUND_PERIOD_MS;
const sats = (n) => n / 1e8;
const UTXOS = [
  { txid: 'b'.repeat(64), vout: 0, amount: sats(50000), spendable: true, solvable: true },
  { txid: 'c'.repeat(64), vout: 1, amount: sats(1670), spendable: true, solvable: true },
  { txid: 'e'.repeat(64), vout: 3, amount: sats(12000), spendable: true, solvable: true },
];
const SPEC = { mtp: {}, tip: { blocks: 150100, mediantime: Number((START - 48n * 3600000n) / 1000n) }, utxos: UTXOS, input: { txid: 'e'.repeat(64), vout: 3 }, mempool: { allowed: true }, send: 'a'.repeat(64) };
const ROUTES = { '/rounds?next=4': { rounds: [{ id: 'f'.repeat(64), free: true }, { id: RID, free: false }] }, [`/round?id=${RID}`]: encodeRoundContract(LIVE) };
const run = (spec, extra = []) => runTool(TOOL, { spec, routes: ROUTES, args: (url, dir) => [url, new Date(Number(START)).toISOString(), dir, ...extra] });

test('a dry run writes the late-join tail from the live paid round, and broadcasts nothing', async () => {
  const r = await run(SPEC);
  assert.equal(r.code, 0, r.stderr);
  const name = Object.keys(r.files).find((f) => /^late-tail-[0-9a-f]{16}-dry\.json$/.test(f));
  assert.ok(name, `no dry record: ${Object.keys(r.files)}`);
  const rec = JSON.parse(r.files[name]);
  const t = decodeRoundContract(Uint8Array.from(Buffer.from(rec.template, 'hex')));
  assert.equal(t.startTimeMs, START);
  assert.equal(t.entryCloseMs, START + LATE_JOIN_MS, 'entry does not close 45 s after the start');
  assert.equal(t.committeeTimeMs, START - TAIL_COMMITTEE_LEAD_MIN_MS);
  assert.equal(rec.count, ROUNDS_PER_SERIES - 200);
  assert.equal(hex(t.federationId), hex(LIVE.federationId));
  assert.equal(t.stakeMsat, LIVE.stakeMsat);
  // the series id hashes the tail's count with its template (series.js seriesId), the count the record names
  assert.equal(rec.series, hex(seriesId(t, { count: rec.count })));
  assert.equal(rec.payload, hex(seriesPublicationPayload(seriesId(t, { count: rec.count }))));
  assert.equal(rec.line, `${rec.template} count=${rec.count}`);
  assert.ok(!r.methods.includes('sendrawtransaction'), 'a dry run sent');
  assert.deepEqual(JSON.parse(r.calls.find((c) => c.method === 'createrawtransaction').params[0]), [{ txid: 'e'.repeat(64), vout: 3 }]);
});

test('only a bond and a marker: refused by name, nothing built; off the 90 s grid or at a day\'s first round: refused', async () => {
  const r = await run({ ...SPEC, utxos: UTXOS.slice(0, 2) }, ['--send']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no non-bond output of 5000 sat or more/);
  assert.ok(!r.methods.includes('createrawtransaction') && !r.methods.includes('sendrawtransaction'));
  const off = await runTool(TOOL, { spec: SPEC, routes: ROUTES, args: (url, dir) => [url, new Date(Number(START + 1000n)).toISOString(), dir] });
  assert.match(off.stderr, /is not on the 90 s grid from genesis_series_start/);
  const first = await runTool(TOOL, { spec: SPEC, routes: ROUTES, args: (url, dir) => [url, new Date(Number(DAY)).toISOString(), dir] });
  assert.match(first.stderr, /a tail starts inside its day, not at its first round/);
  assert.equal(off.methods.length + first.methods.length, 0, 'the chain was asked before the grid was checked');
});

test('--send broadcasts once after the mempool accepts; a refused one is not sent; another input than the chosen is refused', async () => {
  const sent = await run(SPEC, ['--send']);
  assert.equal(sent.code, 0, sent.stderr);
  assert.equal(sent.methods.filter((m) => m === 'sendrawtransaction').length, 1);
  assert.ok(Object.keys(sent.files).some((f) => /^late-tail-[0-9a-f]{16}\.json$/.test(f)));
  const refused = await run({ ...SPEC, mempool: { allowed: false, reason: 'bad-txns' } }, ['--send']);
  assert.match(refused.stderr, /the mempool refuses the publication: bad-txns/);
  assert.ok(!refused.methods.includes('sendrawtransaction'));
  const other = await run({ ...SPEC, input: { txid: 'b'.repeat(64), vout: 0 } }, ['--send']);
  assert.match(other.stderr, /the publication spends something other than the chosen output/);
  assert.ok(!other.methods.includes('sendrawtransaction'));
});
