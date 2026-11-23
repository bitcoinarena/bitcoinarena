// kanban #1489 #3142 refute of #2994: a REPLAYED signed body on a stranger's dust bond still decides for the node (newestPerNode ignores the #2426 timestamp rule)
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
// a stranger's dust bond to the victim's key whose creation body is a body the victim once SIGNED (public on chain): it verifies
const replayBond = (a, sig) => bondTransaction(a, { previousTxid: b32(0xee), previousVout: 0, outputKey: bondFor(keyFor(VICTIM)), value: 330, signature: sig });
const why = (out) => (out.excluded || []).filter((e) => e.pubkey && toHex(e.pubkey) === toHex(keyFor(VICTIM))).map((e) => `${e.step}: ${e.why}`);

test('refute #2994 v1: a stranger replays the victim\'s OLD signed step-out body as a dust bond - the victim, back in since, stays in', () => {
  const out1 = signedUpdate({ serving: false, timestamp: 2000n }, 0xa7);
  const back = signedUpdate({ timestamp: 3000n }, 0xa8);
  const at = { ...honestAt, [HEIGHT - 22]: [out1.tx], [HEIGHT - 20]: [back.tx], [HEIGHT - 15]: [replayBond(out1.a, out1.sig)] };
  const control = censusOfView(view({ ...honestAt, [HEIGHT - 22]: [out1.tx], [HEIGHT - 20]: [back.tx] }), contract);
  assert.equal(inCensus(control, VICTIM), true, 'control: stepped out then back in -> in the census');
  const out = censusOfView(view(at), contract);
  assert.equal(out.ok, true, out.why);
  console.log(`  MEASURED v1: victim in census=${inCensus(out, VICTIM)}; excluded as ${JSON.stringify(why(out))}`);
  assert.equal(inCensus(out, VICTIM), true, 'a replayed old signed body (timestamp 2000 < the victim\'s newest 3000) stepped the victim out');
});

test('refute #2994 v2: a stranger replays the victim\'s signed creation body after it stepped out - the step-out holds', () => {
  const out1 = signedUpdate({ serving: false, timestamp: 2000n }, 0xa7);
  const created = advertFor(VICTIM);
  const at = { ...honestAt, [HEIGHT - 20]: [out1.tx], [HEIGHT - 15]: [replayBond(created, schnorr.sign(advertId(created), SECRET(VICTIM)))] };
  const control = censusOfView(view({ ...honestAt, [HEIGHT - 20]: [out1.tx] }), contract);
  assert.equal(inCensus(control, VICTIM), false, 'control: the victim stepped out');
  const out = censusOfView(view(at), contract);
  assert.equal(out.ok, true, out.why);
  console.log(`  MEASURED v2: victim in census=${inCensus(out, VICTIM)}`);
  assert.equal(inCensus(out, VICTIM), false, 'a replayed creation body (timestamp 1000 < step-out 2000) undid the victim\'s signed step-out');
});
