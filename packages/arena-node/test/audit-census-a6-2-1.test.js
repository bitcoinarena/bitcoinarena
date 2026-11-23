// Audit 2026-11-22b, module census, round 2, finding 1.
// A STRANGER'S OWN BOND TO A GUARDIAN'S NODE KEY, UNDER ANOTHER OPERATOR ID, REDIRECTS THE GUARDIAN'S FEE SHARE TO THE STRANGER'S
// PAYOUT KEY.
//
// The seat's census (roster.js censusOfView -> deriveCensus) checks no bond body's signature and groups a node's outputs by node
// key AND operator id (census.js nodeKeyOf). A stranger's bond (one bond_min) to bondOutputKey(victim) with an UNSIGNED body naming
// the victim's node key, ANOTHER operator id and the stranger's payoutPubkey is a group of its own: it passes the floor on its own
// sum and is in the census under the victim's key. roster.guardianPayoutsFor (roster.js:637) then walks the census entries in
// (txid, vout) order and Map.set()s node key -> payout key for each, so the LAST entry of the victim's key decides - the stranger
// grinds his funding outpoint until his bond's txid sorts after the victim's. server.js:3565 hands that map to the settlement
// (lock-settlement.js:666 payoutOf): every guardian, gateway and liquidity share owed to the victim is paid to the stranger's key.
// The safe behaviour: a guardian is paid only to a payout key its own signed advertisement names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { advertId } from '../../arena-protocol/src/advert.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { chainOf as minedChain } from '../../arena-protocol/tools/chainview.js';
import { bondTransaction } from '../../arena-protocol/tools/bond.js';
import { Roster, censusOfView } from '../src/roster.js';
import { keyFor, bondFor } from './curve.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const SECRET = (n) => new Uint8Array(32).fill(n);
const VICTIM = 0x11;
const FID = b32(0x77);
const VICTIM_PAYOUT = schnorr.getPublicKey(b32(0x21)), STRANGER_PAYOUT = schnorr.getPublicKey(b32(0x66));
const advertFor = (n, over = {}) => ({
  nodePubkey: keyFor(n), operatorId: `op-${n}`, protocolVersions: [19],
  hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'settlement'], endpoint: `ws://node${n}`, region: 'eu-west', capacityClass: 1,
  softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: schnorr.getPublicKey(b32(0x30 + n)), guardianOf: [], timestamp: 1000n, ...over,
});
const signedBond = (n, over = {}) => {
  const a = advertFor(n, over);
  return bondTransaction(a, { previousTxid: b32(0xa0 + n), previousVout: 0, outputKey: bondFor(keyFor(n)), value: 60000,
    signature: schnorr.sign(advertId(a), SECRET(n)) });
};
const HEIGHT = 900000;
const view = (at, tip = HEIGHT + 2, from = HEIGHT - 30) => {
  const blocks = [];
  for (let h = from; h <= tip; h++) blocks.push({ transactions: at[h] || [] });
  return minedChain(blocks, from);
};
const base = { gameId: NEXTBLOCK_GAME_ID, bondMinSats: 50000n, protocolVersion: 19, censusHeight: HEIGHT, censusConfirmations: 6, networkId: NETWORK_ID_REGTEST };

const victimBond = signedBond(VICTIM, { payoutPubkey: VICTIM_PAYOUT });
const victimTxid = parseTransaction(victimBond).txid;
const higher = (a, b) => { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
// the stranger's own coin, one bond_min to the victim's bond key, an UNSIGNED body: the victim's node key, ANOTHER operator id, the
// stranger's payout key - its funding outpoint ground until its txid sorts AFTER the victim's bond (a try or two)
let forged = null;
for (let i = 0; i < 4096 && !forged; i++) {
  const prev = b32(0xee); prev[0] = i & 0xff; prev[1] = i >> 8;
  const tx = bondTransaction(advertFor(VICTIM, { operatorId: 'op-stranger', payoutPubkey: STRANGER_PAYOUT }),
    { previousTxid: prev, previousVout: 0, outputKey: bondFor(keyFor(VICTIM)), value: 50000 });
  if (higher(parseTransaction(tx).txid, victimTxid)) forged = tx;
}

const rosterOver = (at) => {
  const v = view(at);
  const c = censusOfView(v, base);
  assert.equal(c.ok, true, c.why);
  const contract = { ...base, censusRoot: c.root, federationId: FID };
  const rid = b32(0x42);
  const round = { contractOf: () => contract, get: () => null, openCount: 0 };
  return { roster: new Roster(round, { chainFor: () => v }), rid, census: c };
};

test('audit census a6-2-1: control - with no stranger bond the guardian is paid to its own payout key', () => {
  const { roster, rid } = rosterOver({ [HEIGHT - 25]: [victimBond, signedBond(0x12), signedBond(0x13)] });
  const m = roster.guardianPayoutsFor(rid);
  assert.equal(toHex(m.get(toHex(keyFor(VICTIM)))).slice(2), toHex(VICTIM_PAYOUT));
});

test('audit census a6-2-1: a stranger\'s own bond to the guardian\'s key does not move where the guardian is paid', () => {
  assert.ok(forged, 'a forged bond sorting after the victim\'s was found');
  const { roster, rid, census } = rosterOver({ [HEIGHT - 25]: [victimBond, signedBond(0x12), signedBond(0x13)], [HEIGHT - 15]: [forged] });
  const mine = census.entries.filter((e) => toHex(e.pubkey) === toHex(keyFor(VICTIM)));
  console.log(`  MEASURED: census entries under the victim's key: ${mine.map((e) => `${toHex(e.txid).slice(0, 8)} op=${e.advert.operatorId} payout=${toHex(e.advert.payoutPubkey).slice(0, 8)}`).join(', ')}`);
  const pk = roster.guardianPayoutsFor(rid).get(toHex(keyFor(VICTIM)));
  console.log(`  MEASURED: guardianPayoutsFor(victim) = ${pk ? toHex(pk).slice(2, 18) : 'none'} (victim ${toHex(VICTIM_PAYOUT).slice(0, 16)}, stranger ${toHex(STRANGER_PAYOUT).slice(0, 16)})`);
  assert.notEqual(toHex(pk).slice(2), toHex(STRANGER_PAYOUT), 'the guardian\'s fee share is paid to the stranger\'s payout key');
  assert.equal(toHex(pk).slice(2), toHex(VICTIM_PAYOUT));
});
