// Audit 2026-11-25, module census, round 2, finding 1.
// A STRANGER'S OWN BOND TO A NODE'S KEY, UNDER ANOTHER OPERATOR ID, NAMES WHERE EVERY SEAT DIALS THAT NODE WHEN IT IS DRAWN
// (gap in the #3348 / #3364 point fixes: they skip nodeSigned === false entries for the emergency key and the payout key only).
//
// The seat's census (roster.js censusOfView -> deriveCensus) keeps a stranger's bond_min output to bondOutputKey(victim) with an UNSIGNED
// body naming the victim's node key and another operator id as an entry of its own (nodeSigned: false). selectCommittee (sortition.js)
// merges all entries of one node key and draws the key on its LOWEST outpoint's entry - the stranger grinds his funding outpoint until his
// txid sorts first - so the drawn entry is the stranger's, with his endpoint. endpointsOf (roster.js:100) / the address book's
// endpointOf then dial the stranger for the victim, and the victim's own signed address announcement does not help: it is taken only
// when it is newer than the advert's timestamp, which the stranger's unsigned body sets far ahead.
// Safe behaviour: a drawn node is dialed at an endpoint its own node key signed (its signed body or its announcement).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { advertId } from '../../arena-protocol/src/advert.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { chainOf as minedChain } from '../../arena-protocol/tools/chainview.js';
import { bondTransaction } from '../../arena-protocol/tools/bond.js';
import { drawCommittee } from '../../arena-protocol/src/sortition.js';
import { signAddressAnnouncement, endpointOf as announcedEndpointOf } from '../../arena-protocol/src/address-announcement.js';
import { censusOfView, endpointsOf } from '../src/roster.js';
import { keyFor, bondFor } from './curve.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const SECRET = (n) => new Uint8Array(32).fill(n);
const VICTIM = 0x11;
const advertFor = (n, over = {}) => ({
  nodePubkey: keyFor(n), operatorId: `op-${n}`, protocolVersions: [19],
  hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'settlement'], endpoint: `https://node${n}.example`, region: 'eu-west', capacityClass: 1,
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
const contract = { gameId: NEXTBLOCK_GAME_ID, bondMinSats: 50000n, protocolVersion: 19, censusHeight: HEIGHT, censusConfirmations: 6,
  networkId: NETWORK_ID_REGTEST, gameVerifySlots: 2, settlementSlots: 2 };

const victimBond = signedBond(VICTIM);
const victimTxid = parseTransaction(victimBond).txid;
const lower = (a, b) => { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };
// the stranger's own coin, one bond_min to the victim's bond key, an UNSIGNED body: the victim's node key, another operator id, the
// stranger's endpoint and a timestamp far ahead - funding outpoint ground until the txid sorts BEFORE the victim's bond
let forged = null;
for (let i = 0; i < 4096 && !forged; i++) {
  const prev = b32(0xee); prev[0] = i & 0xff; prev[1] = i >> 8;
  const tx = bondTransaction(advertFor(VICTIM, { operatorId: 'op-stranger', endpoint: 'https://stranger.example', timestamp: 1n << 52n }),
    { previousTxid: prev, previousVout: 0, outputKey: bondFor(keyFor(VICTIM)), value: 50000 });
  if (lower(parseTransaction(tx).txid, victimTxid)) forged = tx;
}

// the victim's own signed address announcement (it moved its tunnel), held by the seat's address book
const announced = new Map([[toHex(keyFor(VICTIM)), signAddressAnnouncement({ node: toHex(keyFor(VICTIM)), endpoint: 'https://victim-now.example', atMs: Date.now() },
  (d) => schnorr.sign(d, SECRET(VICTIM)))]]);
const dialOf = (drawn) => {
  const e = drawn.find((x) => toHex(x.pubkey) === toHex(keyFor(VICTIM)));
  return e ? endpointsOf([e], null, (x) => announcedEndpointOf(x, announced))[0] : null;
};
const drawAll = (at) => {
  const c = censusOfView(view(at), contract);
  assert.equal(c.ok, true, c.why);
  // three nodes, three drawn for a 2-seat role: every node is drawn, the victim among them
  return { census: c, drawn: drawCommittee({ entries: c.entries, contract, role: 'settlement', committeeSeed: b32(0x5e) }) };
};

test('audit census a8-2-1: control - with no stranger bond the drawn victim is dialed at its own announced address', () => {
  const { drawn } = drawAll({ [HEIGHT - 25]: [victimBond, signedBond(0x12), signedBond(0x13)] });
  assert.equal(dialOf(drawn), 'https://victim-now.example');
});

test('audit census a8-2-1: a stranger\'s own bond to the node\'s key does not move where seats dial the drawn node', () => {
  assert.ok(forged, 'a forged bond sorting before the victim\'s was found');
  const { census, drawn } = drawAll({ [HEIGHT - 25]: [victimBond, signedBond(0x12), signedBond(0x13)], [HEIGHT - 15]: [forged] });
  const mine = census.entries.filter((e) => toHex(e.pubkey) === toHex(keyFor(VICTIM)));
  console.log(`  MEASURED: census entries under the victim's key: ${mine.map((e) => `${toHex(e.txid).slice(0, 8)} op=${e.advert.operatorId} signed=${e.nodeSigned} ep=${e.advert.endpoint}`).join(', ')}`);
  const at = dialOf(drawn);
  console.log(`  MEASURED: drawn victim dialed at ${at}`);
  assert.notEqual(at, 'https://stranger.example', 'every seat dials the stranger for the drawn victim node');
  assert.equal(at, 'https://victim-now.example');
});
