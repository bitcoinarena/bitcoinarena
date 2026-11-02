// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SLASH START IS NOT A BOND SPENT WHILE SEATED (spec 5A.3B, 23A.5, kanban #972). Every reading of a guardian's bond goes through the census, and the census reads a start's output 0 as the same
// bond, so a guardian whose bond is started stays seated with its weight, and only what ends the hold output takes it out. Held here on a real bond transaction and a real start's shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { resolveCensus } from '../../arena-protocol/src/census.js';
import { bond3OutputKey, bondInternalKey, slashStartLeaf } from '../../arena-protocol/src/bond-script.js';
import { serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { bondTransaction } from '../../arena-protocol/tools/bond.js';
import { chainOf } from '../../arena-protocol/tools/chainview.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { guardianPoolOf } from '../src/roster.js';
import { guardiansOf } from '../src/federation-records.js';
import { reserveMembersOf } from '../src/reserve-members.js';
import { tweakPoint, combine } from '../src/curve.js';

const person = (n) => schnorr.getPublicKey(taggedHash('ARENA/test/GuardianStart', Uint8Array.from([n])));
const g = genesisFor('regtest');
const CONFIRMED = 900000 + 20, node = person(1), censusKey = person(2), federationId = new Uint8Array(32).fill(0xfe);
const contract = { bondMinSats: 50000n, protocolVersion: 25, networkId: NETWORK_ID_REGTEST, federationId, censusHeight: CONFIRMED + 30, censusConfirmations: 1 };
const advert = { nodePubkey: node, operatorId: 'operator', protocolVersions: [25], hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'settlement'], endpoint: 'ws://node', region: 'eu-west', capacityClass: 1,
  softwareHash: new Uint8Array(32).fill(2), settlementCapabilities: 0, lightningCapabilities: 0, bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 3, bondMaturityHeight: CONFIRMED + 100,
  censusKey, payoutPubkey: new Uint8Array(32).fill(3), guardianOf: [{ federationId, guardianKey: new Uint8Array(33).fill(2) }], timestamp: 1788700000000n };
const inner = bondInternalKey({ nodeKey: node, arbitrationKeys: g.arbitrationKeys }, { combine }).internalKey;
const { outputKey } = bond3OutputKey({ nodeKey: node, censusKey, arbitrationKeys: g.arbitrationKeys, bondMaturity: advert.bondMaturityHeight, internalKey: inner }, { tweakPoint, combine });
const bondTx = bondTransaction(advert, { outputKey, previousTxid: new Uint8Array(32).fill(0x31) });
const parsed = parseTransaction(bondTx), value = parsed.outputs[0].value;
const from = { txid: parsed.txid, vout: 0, sequence: 0xfffffffd };
const holdScript = fromHex(`5120${'44'.repeat(32)}`);
const start = serializeSpend({ version: 2, locktime: 0, inputs: [from, { txid: new Uint8Array(32).fill(0x22), vout: 0, sequence: 0xfffffffd }], outputs: [{ value, script: holdScript }],
  witnesses: [[new Uint8Array(64), new Uint8Array(65), slashStartLeaf(node, censusKey), new Uint8Array(33)], [new Uint8Array(64)]] });
const startTxid = parseTransaction(start).txid;

const census = (spends) => {
  const byHeight = new Map([[CONFIRMED - 20, [bondTx]], ...spends.map((t, i) => [CONFIRMED - 10 + i, [t]])]);
  const blocks = Array.from({ length: 80 }, (_, i) => ({ transactions: byHeight.get(CONFIRMED - 40 + i) || [] }));
  const r = resolveCensus([{ txid: parsed.txid, vout: 0, pubkey: node, bondSats: value, height: CONFIRMED - 20, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'settlement'], spent: false }], {
    contract, resolve: () => ({ transaction: bondTx }), view: chainOf(blocks, CONFIRMED - 40),
    bond: { arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK, bondMaturity: g.bondMaturity, tweakPoint, combine, standingKeys: [{ epoch: 1, publicKey: censusKey, height: 100 }] } });
  assert.equal(r.ok, true, r.why);
  return { entries: r.eligible, excluded: r.excluded };
};

test('a guardian whose bond is started stays in the census, seated, with its bond counted, and what ends the hold output takes it out', () => {
  const before = census([]), during = census([start]);
  assert.equal(before.entries.length, 1, JSON.stringify(before.excluded.map((x) => x.why)));
  assert.equal(during.entries.length, 1, 'a start is not a spend that ends the bond');
  const read = (c) => ({ row: guardiansOf(c, federationId).map((x) => [toHex(x.nodePubkey), String(x.bondSats)]), pool: guardianPoolOf({ contract, census: c }).map(toHex), reserve: Object.values(reserveMembersOf(c.entries)).flat().length });
  assert.deepEqual(read(during), read(before), 'every reading of a guardian\'s bond answers as before the start');
  assert.equal(read(during).row.length, 1);
  assert.equal(read(during).pool[0], toHex(node));

  const anySpend = serializeSpend({ version: 2, locktime: 0, inputs: [from], outputs: [{ value: value - 1000n, script: holdScript }], witnesses: [[new Uint8Array(64)]] });
  const gone = census([anySpend]);
  assert.equal(gone.entries.length, 0, 'a spend that is no start ends the bond: the node took it back');
  assert.match(gone.excluded[0].why, /was spent at height/);
  assert.deepEqual(gone.excluded[0].spentBy, { txid: toHex(parseTransaction(anySpend).txid), height: CONFIRMED - 10 }, 'what ended it, for the federation record (kanban #1054)');

  const fallback = serializeSpend({ version: 2, locktime: 0, inputs: [{ txid: startTxid, vout: 0, sequence: 24 }], outputs: [{ value: value - 1000n, script: holdScript }], witnesses: [[new Uint8Array(64)]] });
  const ended = census([start, fallback]);
  assert.equal(ended.entries.length, 0, 'a release, a return or the fallback ends it');
  assert.deepEqual(ended.excluded[0].spentBy, { txid: toHex(parseTransaction(fallback).txid), height: CONFIRMED - 9 }, 'the spend of the hold output, not the start, is what ended the bond');
});
