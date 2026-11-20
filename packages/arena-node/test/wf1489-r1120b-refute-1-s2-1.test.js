// kanban #1489 refute r1120b-1 skeptic 2 (#3142 / #2994): a replayed signed body decides again once the output that carried the node's newest bodies leaves the census (withdrawn after its lock, the node's added output still bonded)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { advertId } from '../../arena-protocol/src/advert.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { chainOf as minedChain } from '../../arena-protocol/tools/chainview.js';
import { bondTransaction, advertUpdateTransaction } from '../../arena-protocol/tools/bond.js';
import { censusOfView } from '../src/roster.js';
import { keyFor, bondFor } from './curve.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const SECRET = (n) => new Uint8Array(32).fill(n);   // curve.js keyFor(n) = getPublicKey(fill(n))
const advertFor = (n, over = {}) => ({
  nodePubkey: keyFor(n), operatorId: `op-${n}`, protocolVersions: [19],
  hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'], endpoint: `ws://node${n}`, region: 'eu-west', capacityClass: 1,
  softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: b32(3), guardianOf: [], timestamp: 1000n, ...over,
});
const signedBond = (n, over = {}, opts = {}) => {
  const a = advertFor(n, over);
  return bondTransaction(a, { previousTxid: b32(0xa0 + n), previousVout: 0, outputKey: bondFor(keyFor(n)), value: 60000,
    signature: schnorr.sign(advertId(a), SECRET(n)), ...opts });
};

const HEIGHT = 900000;
const view = (at, tip = HEIGHT + 2, from = HEIGHT - 30) => {
  const blocks = [];
  for (let h = from; h <= tip; h++) blocks.push({ transactions: at[h] || [] });
  return minedChain(blocks, from);
};
const contract = {
  gameId: NEXTBLOCK_GAME_ID, bondMinSats: 50000n, protocolVersion: 19,
  censusHeight: HEIGHT, censusConfirmations: 6, networkId: NETWORK_ID_REGTEST,
};
const VICTIM = 0x11;
const honestAt = { [HEIGHT - 25]: [signedBond(0x11), signedBond(0x12), signedBond(0x13)] };
// the stranger's own coin (prev 0xee), the victim's node key, an unsigned body: the victim's operator id, serving = false,
// a timestamp no real body will ever pass. 330 sats.
const forged = bondTransaction(advertFor(VICTIM, { serving: false, timestamp: (1n << 62n) }), {
  previousTxid: b32(0xee), previousVout: 0, outputKey: bondFor(keyFor(VICTIM)), value: 330 });
const inCensus = (out, n) => out.ok && out.entries.some((e) => toHex(e.pubkey) === toHex(keyFor(n)));

const bondTx = honestAt[HEIGHT - 25][0];
const bondTxid = parseTransaction(bondTx).txid;
const signedUpdate = (over, prev) => {
  const a = advertFor(VICTIM, over);
  const sig = schnorr.sign(advertId(a), SECRET(VICTIM));
  return { a, sig, tx: advertUpdateTransaction(a, { bondTxid, bondVout: 0, signature: sig, previousTxid: b32(prev) }) };
};

const replayBond = (a, sig) => bondTransaction(a, { previousTxid: b32(0xee), previousVout: 0, outputKey: bondFor(keyFor(VICTIM)), value: 330, signature: sig });
const why = (out) => (out.excluded || []).filter((e) => e.pubkey && toHex(e.pubkey) === toHex(keyFor(VICTIM))).map((e) => `${e.step}: ${e.why}`);

// the victim's SECOND output (added beside the first, a later lock): 60,000 sat alone, over the floor
const second = advertFor(VICTIM, { timestamp: 1500n });
const bondB = bondTransaction(second, { previousTxid: b32(0xb7), previousVout: 0, outputKey: bondFor(keyFor(VICTIM)), value: 60000,
  signature: schnorr.sign(advertId(second), SECRET(VICTIM)) });
const bondBTxid = parseTransaction(bondB).txid;
// the owner withdraws the FIRST output after its lock (bond-withdraw.js spends the unlocked outputs; the added one is still locked)
const withdrawA = bondTransaction(advertFor(0x50), { previousTxid: bondTxid, previousVout: 0, marker: false, value: 59000 });
const stepOut = signedUpdate({ serving: false, timestamp: 2000n }, 0xa7);
const backIn = signedUpdate({ timestamp: 3000n }, 0xa8);
const history = { ...honestAt, [HEIGHT - 24]: [bondB], [HEIGHT - 22]: [stepOut.tx], [HEIGHT - 20]: [backIn.tx], [HEIGHT - 18]: [withdrawA] };

test('s2 v1: after the first output is withdrawn, a stranger\'s dust bond replaying the old step-out body steps the victim out', () => {
  const control = censusOfView(view(history), contract);
  assert.equal(control.ok, true, control.why);
  assert.equal(inCensus(control, VICTIM), true, 'control: stepped out, back in, first output withdrawn - in on the second output');
  const out = censusOfView(view({ ...history, [HEIGHT - 15]: [replayBond(stepOut.a, stepOut.sig)] }), contract);
  assert.equal(out.ok, true, out.why);
  console.log(`  MEASURED s2 v1: victim in census=${inCensus(out, VICTIM)}; excluded as ${JSON.stringify(why(out))}`);
  assert.equal(inCensus(out, VICTIM), true, 'a replayed old signed step-out (ts 2000 < the victim\'s newest signed 3000) on a stranger\'s bond stepped the victim out');
});

test('s2 v2: the same replay posted as an UPDATE of the victim\'s remaining output steps it out too', () => {
  const replayUpd = advertUpdateTransaction(stepOut.a, { bondTxid: bondBTxid, bondVout: 0, signature: stepOut.sig, previousTxid: b32(0xe1) });
  const out = censusOfView(view({ ...history, [HEIGHT - 15]: [replayUpd] }), contract);
  assert.equal(out.ok, true, out.why);
  console.log(`  MEASURED s2 v2: victim in census=${inCensus(out, VICTIM)}; excluded as ${JSON.stringify(why(out))}`);
  assert.equal(inCensus(out, VICTIM), true, 'a replayed old signed step-out as an update of the remaining output stepped the victim out');
});

test('s2 v3 (measure only): a stranger front-runs the victim\'s pending step-out into the same block - same content, victim out as it asked', () => {
  const out = censusOfView(view({ ...honestAt, [HEIGHT - 20]: [replayBond(stepOut.a, stepOut.sig), stepOut.tx] }), contract);
  console.log(`  MEASURED s2 v3: victim in census=${inCensus(out, VICTIM)}`);
  assert.equal(inCensus(out, VICTIM), false);
  const back = censusOfView(view({ ...honestAt, [HEIGHT - 20]: [replayBond(stepOut.a, stepOut.sig), stepOut.tx], [HEIGHT - 12]: [backIn.tx] }), contract);
  console.log(`  MEASURED s2 v3 back-in after: victim in census=${inCensus(back, VICTIM)}`);
  assert.equal(inCensus(back, VICTIM), true);
});
