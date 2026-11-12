// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 v1-refute-3 (fix:settle:2, d450a4d96): the fix made encodeEntryContract THROW on a website key that is no curve point, but
// the client's entryFor still passes any 0x02/0x03-prefixed key through (join.js: prefix check only). The page takes that key from a
// stranger's ?ref= link (any /^0[23][0-9a-f]{64}$/, kept 30 days in localStorage as ARENA_FRONTEND_PK). So a link /?ref=02ff..ff makes every
// join of that honest player throw at encode for 30 days. entryFor drops a key that is not a compressed key ("none is named"); it must
// drop a non-point one the same way, so the entry still encodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryFor } from '../src/join.js';
import { encodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { fromHex } from '../../arena-protocol/src/hash.js';
import { feldmanGroup } from '../../arena-node/src/curve.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { TRUCK_68E2_HASH } from '../../nextblock/plugin/truck-cores.js';

const A = 'aa'.repeat(32);
const ANY = { id: new Uint8Array(32).fill(7), protocolVersion: 9, stakeMsat: 1000000n, gameId: NEXTBLOCK_GAME_ID, simCoreHash: fromHex(TRUCK_68E2_HASH),
  federationId: fromHex(A) };
const lockedFor = () => ({ claimKey: { ok: true, ref: new Uint8Array(32).fill(0x9a) },
  stakeLock: { outpoint: { txid: new Uint8Array(32).fill(0xd8), outIdx: 0 }, fields: { paymentImage: { kind: 'point', bytes: Uint8Array.of(2, ...new Uint8Array(32).fill(0x6c)) } } } });

test('#1489 v1-refute-3-1: a ?ref= website key that is no curve point does not stop an honest player joining', () => {
  const ref = fromHex('02' + 'ff'.repeat(32));   // passes the page's /^0[23][0-9a-f]{64}$/ and join.js's prefix check
  const e = { sessionPubkey: new Uint8Array(32).fill(3), roundId: ANY.id,
    ...entryFor(ANY, { seed: new Uint8Array(32).fill(5), curve: feldmanGroup, random: (n) => new Uint8Array(n).fill(9), ...lockedFor(), frontendPk: ref }) };
  let why = null;
  try { encodeEntryContract(e); } catch (err) { why = err.message; }
  console.log(`  FACTS: entryFor named frontendPk=${e.frontendPk ? 'yes' : 'no'}; encode ${why ? 'THREW: ' + why : 'ok'}`);
  assert.equal(why, null, 'the honest player\'s entry cannot be built: the client named a website key the protocol refuses');
});
