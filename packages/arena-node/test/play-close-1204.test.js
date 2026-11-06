// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1204 INSTALLER-DOORS-1: the play socket is open to anyone, and its `close <round>` closed a running round at once - every run
// cut short, the rest of the round's entries and batches refused, the round settled on the cut transcripts. A seat that closes its rounds
// by its own clock (closeAtEnd, every live seat) now takes no close from a socket before the round's end; a harness still can.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

const FUNDED = { funded: () => true };
const b32 = (n) => new Uint8Array(32).fill(n);
const contract = (startTimeMs) => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs, entryCloseMs: startTimeMs === 60500n ? 2000n : startTimeMs, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  stakeMsat: 0n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});
const post = async (port, path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body });
  return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) };
};
const talk = (port) => new Promise((resolve) => {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/play`);
  const said = [];
  sock.addEventListener('message', (e) => { const v = said.shift(); if (v) v(typeof e.data === 'string' ? e.data : '(binary)'); });
  sock.addEventListener('open', () => resolve({ say: (m) => new Promise((r) => { said.push(r); sock.send(m); }), shut: () => sock.close() }));
});
const stateOf = async (port, id) => (await fetch(`http://127.0.0.1:${port}/round?id=${id}`)).headers.get('x-state');

test('#1204 a seat that closes its rounds itself refuses a socket close before the end: the round stays open', async () => {
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, ...FUNDED, closeAtEnd: { everyMs: 3600000 } });
  try {
    // a round that starts in an hour: its end is far ahead
    const opened = await post(node.port, '/round', encodeRoundContract(contract(BigInt(Date.now() + 3600000))));
    assert.equal(opened.status, 201);
    const id = toHex(opened.bytes);
    const sock = await talk(node.port);
    assert.match(await sock.say(`close ${id}`), /^error this seat closes its rounds itself/);
    assert.match(await sock.say(`close ${'ab'.repeat(32)}`), /^error/, 'an id the seat does not hold: refused, nothing kept');
    sock.shut();
    assert.equal(await stateOf(node.port, id), '0', 'still open');
  } finally { await node.close(); }
});

test('#1204 after the round\'s end a socket close is taken, as the seat\'s own sweep would', async () => {
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, ...FUNDED, closeAtEnd: { everyMs: 3600000 } });
  try {
    const opened = await post(node.port, '/round', encodeRoundContract(contract(60500n)));
    assert.equal(opened.status, 201);
    const sock = await talk(node.port);
    assert.equal(await sock.say(`close ${toHex(opened.bytes)}`), 'closed');
    sock.shut();
  } finally { await node.close(); }
});

test('#1204 a harness (closeAtEnd off) still closes its rounds when it says so', async () => {
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, ...FUNDED });
  try {
    const opened = await post(node.port, '/round', encodeRoundContract(contract(BigInt(Date.now() + 3600000))));
    assert.equal(opened.status, 201);
    const sock = await talk(node.port);
    assert.equal(await sock.say(`close ${toHex(opened.bytes)}`), 'closed');
    sock.shut();
  } finally { await node.close(); }
});
