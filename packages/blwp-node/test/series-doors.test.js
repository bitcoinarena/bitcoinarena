// A NODE TAKES A SERIES ROUND ONLY AS THE SERIES DERIVES IT (ALL-BUT-MIN-1727): at the round door, the entry door and
// the settlement door, a round naming a series this node does not hold as derived is refused by name; a round naming
// no series is not touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { encodeRoundContract, encodeEntryContract, roundId } from '../../protocol/src/contracts.js';
import { seriesTemplate, seriesRound, seriesIndexAt } from '../../protocol/src/series.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId } from '../../protocol/src/donation.js';
import { toHex } from '../../protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NOW = 1790600000000;
const base = (nodes) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 0n, entryCloseMs: 0n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2), stakeMsat: 0n,
  bondMinSats: 50000n, blockTicks: 4920 /* 82 s of its 90 s slot (the 82/90 fork: seriesRunFits) */, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
});

test('the round door refuses a series round the series does not derive; with the series gone, entry and settlement are refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'series-doors-'));
  const path = join(dir, 'node.db');
  const probe = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true });
  const nodes = [probe.round.pubkey, b32(8)]; await probe.close();
  const t = seriesTemplate(base(nodes), seriesIndexAt(NETWORK_ID_REGTEST, NOW) - 1);     // the series running at NOW
  const s = await serve(openStore(path), { plugins: HOSTED, port: 0, funded: () => true, roundClock: () => NOW, series: [t] });
  let held;
  try {
    const url = `http://127.0.0.1:${s.port}`;
    const listed = (await (await fetch(`${url}/rounds?ahead=${3600000}`)).json()).rounds;
    assert.ok(listed.length > 0, 'the series\' rounds are written');
    held = listed[0].id;
    const i = seriesRound(t, 0);
    // a series round with its entry window moved, posted: refused by name
    const moved = { ...seriesRound(t, 5), entryCloseMs: seriesRound(t, 5).entryCloseMs + 1000n };
    const r1 = await fetch(`${url}/round`, { method: 'POST', body: encodeRoundContract(moved) });
    assert.equal(r1.status, 409);
    assert.match(await r1.text(), /series round refused: round 5 of series .* opens and closes its entry/);
    // round 960 of the series does not exist
    const r2 = await fetch(`${url}/round`, { method: 'POST', body: encodeRoundContract({ ...i, roundIndex: 960 }) });
    assert.equal(r2.status, 409);
    assert.match(await r2.text(), /outside series .* 0 \.\. 959/);
  } finally { await s.close(); }
  // THE SAME STORE WITHOUT THAT SERIES: its rounds are no longer ones this node holds a series for
  const again = await serve(openStore(path), { plugins: HOSTED, port: 0, funded: () => true, roundClock: () => NOW });
  try {
    const url = `http://127.0.0.1:${again.port}`;
    const entry = encodeEntryContract({ roundId: Uint8Array.from(Buffer.from(held, 'hex')), playerPubkey: b32(3), sessionPubkey: b32(4),
      stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick: 0, stakeCommitment: b32(5), vssSharesRef: b32(6), worldSecret: b32(9),
      stakePoint: new Uint8Array(33), feePreimage: b32(0), stakeLockOutpoint: { txid: b32(0), outIdx: 0n }, feeLockOutpoint: { txid: b32(0), outIdx: 0n }, claimKeyAttestationRef: b32(0) });
    const e = await fetch(`${url}/entry`, { method: 'POST', body: entry });
    assert.equal(e.status, 409);
    assert.match(await e.text(), /entry refused: that round names series .*, and this node holds no such series/);
    const st = await fetch(`${url}/settle-commit?round=${held}`, { method: 'POST' });
    assert.equal(st.status, 409);
    assert.match(await st.text(), /settlement refused: that round names series/);
    console.log(`  FACTS: held ${held.slice(0, 16)}; moved window and index 960 refused at /round; entry and settle refused without the series`);
  } finally { await again.close(); }
});
