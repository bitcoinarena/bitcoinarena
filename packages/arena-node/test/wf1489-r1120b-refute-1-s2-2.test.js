// kanban #1489 refute r1120b-1 skeptic 2 (#3142 / #2994): the node's newest bodies on an output older than the census window (2016 blocks, regtest/mainnet) are not read, so a replay of one of them on a stranger's bond decides
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
const view = (at, tip = HEIGHT + 2, from = HEIGHT - 2100) => {
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


// first output A at HEIGHT-2050 (below the 2016-block window), its updates inside the window; the added output B inside the window
const OLD = HEIGHT - 2050;
const second = advertFor(VICTIM, { timestamp: 1500n });
const bondB = bondTransaction(second, { previousTxid: b32(0xb7), previousVout: 0, outputKey: bondFor(keyFor(VICTIM)), value: 60000,
  signature: schnorr.sign(advertId(second), SECRET(VICTIM)) });
const stepOut = signedUpdate({ serving: false, timestamp: 2000n }, 0xa7);
const backIn = signedUpdate({ timestamp: 3000n }, 0xa8);
const others = [signedBond(0x12), signedBond(0x13)];
const history = { [OLD]: [bondTx], [HEIGHT - 25]: others, [HEIGHT - 2000]: [bondB], [HEIGHT - 1990]: [stepOut.tx], [HEIGHT - 1980]: [backIn.tx] };

test('s2 v4: a replayed old step-out on a stranger\'s bond steps out a node whose newest updates sit on an output below the census window', () => {
  const control = censusOfView(view(history), contract);
  assert.equal(control.ok, true, control.why);
  console.log(`  MEASURED s2 v4 control: victim in census=${inCensus(control, VICTIM)}`);
  assert.equal(inCensus(control, VICTIM), true, 'control: back in, its added output in the window - in');
  const out = censusOfView(view({ ...history, [HEIGHT - 15]: [replayBond(stepOut.a, stepOut.sig)] }), contract);
  assert.equal(out.ok, true, out.why);
  console.log(`  MEASURED s2 v4: victim in census=${inCensus(out, VICTIM)}; excluded as ${JSON.stringify(why(out))}`);
  assert.equal(inCensus(out, VICTIM), true, 'a replayed old signed step-out (ts 2000 < the victim\'s newest signed 3000) stepped the victim out');
});
