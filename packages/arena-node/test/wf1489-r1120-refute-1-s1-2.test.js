// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 refute of kanban #3082 (feedback #361, a gap in #2856): the node's duty poster (duty-poster.js seatUrls) builds its seat list from
// the RAW census advert endpoints (no address book check) and asks each one GET /games, GET /headers, POST /expected (announceGrid) and
// POST /series - a bond committing a loopback endpoint sends the duty node's requests to its own loopback service, the #2856 attack, other door.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NETWORK_ID_TESTNET4 } from '../../arena-protocol/src/genesis-ids.js';
import { decodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { fromHex } from '../../arena-protocol/src/hash.js';
import { RPS_MANIFEST_HEX } from '../../rock-paper-scissors/plugin/rps-manifest.js';
import { createDutyPoster } from '../src/duty-poster.js';

const EVIL = 'http://127.0.0.1:18777/lnurlp/tips/cb?amount=1000&x=';

test('wf1489-r1120-refute-1-s1-2: the duty poster does not dial a census endpoint the address book refuses', async () => {
  const me = new Uint8Array(32).fill(1), evil = new Uint8Array(32).fill(2), good = new Uint8Array(32).fill(3);
  const entries = [{ pubkey: me, advert: { endpoint: 'https://me.example' } }, { pubkey: evil, advert: { endpoint: EVIL } }, { pubkey: good, advert: { endpoint: 'wss://good.example' } }];
  const rpsId = toHex(gameIdOf(decodeManifest(fromHex(RPS_MANIFEST_HEX))));
  const dialed = [];
  const fetchFn = async (url) => {
    dialed.push(String(url));
    if (String(url).endsWith('/games')) return new Response(JSON.stringify({ games: [{ id: rpsId, manifest: RPS_MANIFEST_HEX }] }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const call = async (m) => { if (m === 'listwallets') return []; if (m === 'getblockcount') return 100000; if (m === 'getbestblockhash') return '00'.repeat(32); throw new Error(`not served: ${m}`); };
  const poster = createDutyPoster({ call, walletCall: () => async () => [], networkIdHex: () => toHex(NETWORK_ID_TESTNET4),
    censusEntriesAt: async () => entries, dutyCensus: async () => ({ ok: false, why: 'none' }), chainBlocks: async () => ({ blocks: [] }),
    dir: mkdtempSync(join(tmpdir(), 'duty-')), env: { ARENA_DUTY_APPS: 'rps' }, nodeSecret: new Uint8Array(32).fill(7), log: () => {}, fetchFn });
  poster.attach({ port: 1, host: '127.0.0.1', endpoint: null, heldTemplates: () => [], nameFunded: () => {}, donationSetAt: () => new Uint8Array(32), nodeKey: me });
  await poster.pass();
  poster.stop();
  const loopback = dialed.filter((u) => u.startsWith('http://127.0.0.1:18777'));
  console.log('  MEASURED:', JSON.stringify({ dialed: [...new Set(dialed)], loopback }));
  assert.ok(dialed.some((u) => u.startsWith('https://good.example')), 'the honest census seat is asked (the path ran)');
  assert.deepEqual(loopback, [], 'the duty poster sent requests to a census endpoint the address book refuses');
});
