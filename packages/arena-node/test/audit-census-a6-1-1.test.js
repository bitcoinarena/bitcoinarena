// Audit 2026-11-22b, module census, round 1, finding 1.
// A STRANGER'S OWN BOND TO A VICTIM'S NODE KEY, UNDER ANOTHER OPERATOR ID, NAMES THE EMERGENCY KEY THE SEATS CHECK THE VICTIM'S
// LEAVE REQUEST AGAINST.
//
// The seat's census (roster.js censusOfView -> deriveCensus) checks no bond body's signature (no verifyAdvert) and groups a node's
// outputs by node key AND operator id (census.js nodeKeyOf). #2994 / #3142 stop an unsigned body from deciding for the victim's own
// group - but a stranger's bond to bondOutputKey(victim) whose unsigned body names ANOTHER operator id is a group of its own: it
// passes the floor on its own sum (one bond_min, paid by the stranger) and stays in the census under the VICTIM'S node key, with
// the stranger's body - and the stranger's emergencyPubkey - as its advert.
// The three emergency doors pick the advert by node key alone, the FIRST census entry (txid order, which the stranger grinds):
//   server.js:3726 takeEmergency (POST /emergency-departure and the peer pull), server.js:7234 the founding's emergencies,
//   and the record's emergencyDeparted (federation-records.js:660) on what was taken.
// So the stranger signs a leave request for the victim with his own key: it stands, every seat keeps it and passes it on,
// leftNode(victim) is true (seating-agent.js: no PRESENT, no seat in any round), and a guardian victim is DEPARTED - its
// federation's succession starts.
// The safe behaviour: a leave request for a node stands only under an emergency key the node itself named (its own signed body).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { advertId } from '../../arena-protocol/src/advert.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { chainOf as minedChain } from '../../arena-protocol/tools/chainview.js';
import { bondTransaction } from '../../arena-protocol/tools/bond.js';
import { emergencyEntryOf, emergencyDepartureStands, signEmergencyDeparture } from '../../arena-protocol/src/emergency.js';
import { censusOfView } from '../src/roster.js';
import { createAbsences } from '../src/absences.js';
import { keyFor, bondFor } from './curve.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const SECRET = (n) => new Uint8Array(32).fill(n);
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const VICTIM = 0x11;
const VICTIM_EM = new Uint8Array(32).fill(0x61), STRANGER_EM = new Uint8Array(32).fill(0x62);
const advertFor = (n, over = {}) => ({
  nodePubkey: keyFor(n), operatorId: `op-${n}`, protocolVersions: [19],
  hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'settlement'], endpoint: `ws://node${n}`, region: 'eu-west', capacityClass: 1,
  softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: b32(3), guardianOf: [], timestamp: 1000n, ...over,
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
const contract = { gameId: NEXTBLOCK_GAME_ID, bondMinSats: 50000n, protocolVersion: 19, censusHeight: HEIGHT, censusConfirmations: 6, networkId: NETWORK_ID_REGTEST };

const victimBond = signedBond(VICTIM, { emergencyPubkey: schnorr.getPublicKey(VICTIM_EM) });
const victimTxid = parseTransaction(victimBond).txid;
const lower = (a, b) => { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };
// the stranger's own coin, one bond_min to the victim's bond key, an UNSIGNED body: the victim's node key, ANOTHER operator id, and
// the stranger's emergency key - its funding outpoint ground until its txid sorts before the victim's bond (a few tries)
let forged = null;
for (let i = 0; i < 4096 && !forged; i++) {
  const prev = b32(0xee); prev[0] = i & 0xff; prev[1] = i >> 8;
  const tx = bondTransaction(advertFor(VICTIM, { operatorId: 'op-stranger', emergencyPubkey: schnorr.getPublicKey(STRANGER_EM) }),
    { previousTxid: prev, previousVout: 0, outputKey: bondFor(keyFor(VICTIM)), value: 50000 });
  if (lower(parseTransaction(tx).txid, victimTxid)) forged = tx;
}
const at = { [HEIGHT - 25]: [victimBond, signedBond(0x12), signedBond(0x13)], [HEIGHT - 15]: [forged] };
// exactly the pick of server.js takeEmergency, the founding's emergencies and federation-records (emergencyEntryOf)
const advertOf = (entries, node) => (emergencyEntryOf(entries, node) || {}).advert;   // the doors' pick since kanban #3348 (emergency.js)
const request = (secret, postedAt) => signEmergencyDeparture({ nodePubkey: keyFor(VICTIM), emergencyPubkey: schnorr.getPublicKey(secret), postedAt },
  (m) => schnorr.sign(m, secret));

test('audit census a6-1-1: control - the victim\'s own emergency key makes a leave request that stands', () => {
  const out = censusOfView(view({ [HEIGHT - 25]: at[HEIGHT - 25] }), contract);
  assert.equal(out.ok, true, out.why);
  const st = emergencyDepartureStands(request(VICTIM_EM, HEIGHT), { advert: advertOf(out.entries, keyFor(VICTIM)), tip: HEIGHT, verify, fresh: true });
  assert.equal(st.ok, true, st.why);
});

test('audit census a6-1-1: a stranger\'s own bond to the victim\'s key does not let him sign the victim out of the seating', () => {
  assert.ok(forged, 'a forged bond sorting first was found');
  const out = censusOfView(view(at), contract);
  assert.equal(out.ok, true, out.why);
  const mine = out.entries.filter((e) => toHex(e.pubkey) === toHex(keyFor(VICTIM)));
  console.log(`  MEASURED: census entries under the victim's key: ${mine.map((e) => `${toHex(e.txid).slice(0, 8)} op=${e.advert.operatorId} em=${toHex(e.advert.emergencyPubkey || new Uint8Array(0)).slice(0, 8)}`).join(', ')}`);
  const advert = advertOf(out.entries, keyFor(VICTIM));
  const d = request(STRANGER_EM, HEIGHT);
  const st = emergencyDepartureStands(d, { advert, tip: HEIGHT, verify, fresh: true });
  // what the seat does with a request that stands: kept, and the seating's leftNode (server.js:3789) reads it
  const seat = createAbsences({ verify });
  if (st.ok) seat.offerEmergency(d);
  console.log(`  MEASURED: stranger-signed leave request stands=${st.ok} (${st.why || 'ok'}); leftNode(victim)=${!!seat.emergencyFor(keyFor(VICTIM))}`);
  assert.equal(st.ok, false, 'a leave request signed by the stranger\'s key stands for the victim: the victim leaves every seating (and a guardian is DEPARTED)');
  assert.equal(!!seat.emergencyFor(keyFor(VICTIM)), false);
});
