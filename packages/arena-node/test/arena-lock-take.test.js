// POST /lock FOR A PROTOCOL-27 ROUND (kanban #1044 B1): the seat takes an Arena lock - the federation runs the variant, holds exactly that contract at
// the outpoint, and the contract names the round, its settlement seats in seat order and its threshold; a stock round keeps the stock contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { arenaLockFor, arenaLockContractId } from '../../arena-protocol/src/arena-lock.js';
import { lockFieldsFromJson, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { arenaLockStands } from '../src/stake-lock-signer-node.js';

const KEYS = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798,c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5,f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9,e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13,2f8bde4d1a07209355b4a7250a5c5128e88b84bddc619ab7cba8d569b240efe4,fff97bd5755eeea420453a14355235d382f6472f8568a18b2f057a1460297556,5cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc'.split(',').map(fromHex);
const b32 = (v) => new Uint8Array(32).fill(v);
const HEIGHT = 300;
const entry = { roundId: b32(0x11), playerPubkey: b32(0x05), stakeCommitment: b32(0x04), stakeMsat: 100000n, feeMsat: 2000n, donationMsat: 0n,
  stakePoint: Uint8Array.from([0x03, ...b32(0x21)]), feePreimage: b32(0x07) };
const contract = (over = {}) => ({ protocolVersion: 27, networkId: NETWORK_ID_REGTEST, censusHeight: 10, nodes: KEYS, settlementSlots: 7, stakeExpiryBlocks: 144, ...over });
const lock = (over = {}) => ({ ...arenaLockFor({ kind: 'stake', entry, roundId: entry.roundId, seatKeys: KEYS, threshold: 5, amountMsat: netStakeMsat(entry), imageBytes: entry.stakePoint }),
  expiration: HEIGHT + 144, fallbackAfter: HEIGHT + 3, arena: true, ...over });
const portHolding = (held) => ({ arenaStatus: async () => ({ blockCount: HEIGHT, stored: held ? { contractId: toHex(arenaLockContractId(held)), blocksLeft: 144, expiration: held.expiration, fallbackAfter: held.fallbackAfter } : null }) });
const take = (over) => arenaLockStands({ contract: contract(), entry, kind: 'stake', fields: lock(), outpoint: { txid: b32(9), outIdx: 0 }, port: portHolding(lock()), federationId: b32(0xfe), ...over });

test('the lock JSON is the Arena lock\'s when it names claim keys, and round-trips', () => {
  const j = lockFieldsToJson(lock());
  assert.ok(Array.isArray(j.claimKeys));
  const back = lockFieldsFromJson(j);
  assert.equal(back.arena, true);
  assert.equal(toHex(arenaLockContractId(back)), toHex(arenaLockContractId(lock())));
});

test('a protocol-27 round takes its Arena lock; every way of being another lock is refused by name', async () => {
  assert.equal((await take()).ok, true);
  assert.match((await take({ port: portHolding(null) })).why, /holds no Arena lock/);
  assert.match((await take({ port: portHolding(lock({ amountMsat: 1n })) })).why, /its id is another/);
  assert.match((await take({ fields: lock({ expiration: HEIGHT + 145 }), port: portHolding(lock({ expiration: HEIGHT + 145 })) , contract: contract({ nodes: [KEYS[1], KEYS[0], ...KEYS.slice(2)] }) })).why, /seat order/);
  assert.match((await take({ fields: lock({ roundId: b32(0x12) }), port: portHolding(lock({ roundId: b32(0x12) })) })).why, /another round/);
  // the fallback height (kanban #1281): the lock's count plus regtest's stall_blocks 3, and the one the federation holds
  assert.match((await take({ fields: lock({ fallbackAfter: HEIGHT + 4 }), port: portHolding(lock({ fallbackAfter: HEIGHT + 4 })) })).why, /fallback height 304 is not its block count plus stall_blocks 3/);
  assert.match((await take({ port: { arenaStatus: async () => ({ blockCount: HEIGHT, stored: { contractId: toHex(arenaLockContractId(lock())), blocksLeft: 144, expiration: HEIGHT + 144, fallbackAfter: HEIGHT + 9 } }) } })).why, /fallback height is not the one the federation holds/);
  const stock = { paymentImage: { kind: 'point', bytes: entry.stakePoint }, amountMsat: netStakeMsat(entry), claimPk: new Uint8Array(33), refundPk: new Uint8Array(33), expiration: 444 };
  assert.match((await take({ fields: stock })).why, /stock contract to one claim key/);
  assert.match((await take({ gate: async () => 'not running' })).why, /not running/);
  let asked = null;
  assert.equal((await take({ gate: async (c, fid) => { asked = fid; return null; } })).ok, true);
  assert.equal(asked, 'fe'.repeat(32));
});

test('a protocol-26 round keeps the stock path: nothing here for a stock lock, an Arena lock refused', async () => {
  assert.equal(await take({ contract: contract({ protocolVersion: 26 }), fields: { claimPk: new Uint8Array(33) } }), null);
  assert.match((await take({ contract: contract({ protocolVersion: 26 }) })).why, /locks to the stock contract/);
});
