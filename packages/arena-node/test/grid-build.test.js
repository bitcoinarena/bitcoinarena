// A GRID FROM A TEMPLATE THAT NAMES NO CENSUS ROOT YET (kanban #702, measured 2026-10-27 08:33Z): the node's own day duty builds its templates
// fresh, so the root comes only from censusRootFor - and every grid it tried to post failed with "expected 32 bytes, got nothing", because the
// last round was derived (and encoded) before the root was set. Built here as the node builds one: every template and every series names the root.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGrid } from '../src/grid-build.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const ROOT = b32(0x77);
const contract = {
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(1),
  custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [],
  donationSetId: b32(0xd0), censusHeight: 157740, randomnessRule: 'bitcoin-block-hash', stakeMsat: 1000000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  objectionWindowMs: 600000n, nodes: [], protocolVersion: 3,
};

test('a template with no census root: the grid is built, and every template names the root censusRootFor gives', () => {
  const asked = [];
  const got = buildGrid({ contract, kind: { fields: {} }, slots: 4, tables: 1, windowMs: 900000n, entryAfterStartMs: 60000n,
    committeeTimeMs: 1_800_000_000_000n, firstCloseMs: 1_800_007_260_000n, censusRootFor: (t) => { asked.push(t.censusRoot); return ROOT; } });
  assert.ok(got && got.ids && got.ids.length === 1, 'one series');
  assert.equal(toHex(asked[1]), toHex(ROOT), 'the last round is derived with the root already named');
});
