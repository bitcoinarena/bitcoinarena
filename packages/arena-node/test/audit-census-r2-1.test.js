// Audit 2026-11-18, module census, round 2, finding 1.
// A STRANGER STEPS ANY BONDED NODE OUT OF EVERY CENSUS, FOR GOOD, WITH ONE DUST BOND HE FUNDS HIMSELF.
//
// The seat's census (roster.js censusOfView -> deriveCensus) is called with no `verifyAdvert`: a bond output's own
// advertisement is never signature-checked (BOND_UNCHECKED) - the output key is rebuilt from the node key the body names,
// so the body is "bound to the money". But anyone can pay a bond output to ANY node's key: the key is rebuilt from public
// data (the node key, the network's arbitration set, the maturity). A stranger posts a 330-sat bond to the victim's node key,
// committing an unsigned body that copies the victim's operator id and says serving = false with a huge timestamp.
//  - protocol 19 (sumsBonds): newestPerNode lets that output's own body (the newest block) decide for EVERY output of the node:
//    the victim is out of the census (step 'update', "stepped out").
//  - the huge timestamp is also "the newest body of that node" in newestUpdates (#2426's rule), so every later real update the
//    victim signs is "not newer" and ignored: it can never step back in with that key.
// The safe behaviour: a body nobody showed is the node's (no valid signature by the key it names) decides nothing about that node.
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

test('audit census r2-1: control - without the stranger\'s output the victim is in the census', () => {
  const out = censusOfView(view(honestAt), contract);
  assert.equal(out.ok, true, out.why);
  assert.equal(inCensus(out, VICTIM), true, 'honest census holds the victim');
});

test('audit census r2-1: a stranger\'s unsigned dust bond to the victim\'s key does not step the victim out', () => {
  const at = { ...honestAt, [HEIGHT - 15]: [forged] };
  const out = censusOfView(view(at), contract);
  assert.equal(out.ok, true, out.why);
  const why = (out.excluded || []).filter((e) => e.pubkey && toHex(e.pubkey) === toHex(keyFor(VICTIM))).map((e) => `${e.step}: ${e.why}`);
  console.log(`  MEASURED: victim in census=${inCensus(out, VICTIM)}; excluded as ${JSON.stringify(why)}`);
  assert.equal(inCensus(out, VICTIM), true, 'an advertisement the victim never signed took the victim out of the census');
});

test('audit census r2-1: the victim\'s own later signed update (serving = true) brings it back', () => {
  // the victim notices and signs a fresh update of its real bond, mined after the forgery
  const bondTx = honestAt[HEIGHT - 25][0];
  const back = advertFor(VICTIM, { timestamp: 5000n });
  const upd = advertUpdateTransaction(back, { bondTxid: parseTransaction(bondTx).txid, bondVout: 0,
    signature: schnorr.sign(advertId(back), SECRET(VICTIM)), previousTxid: b32(0xa9) });
  const at = { ...honestAt, [HEIGHT - 15]: [forged], [HEIGHT - 10]: [upd] };
  const out = censusOfView(view(at), contract);
  assert.equal(out.ok, true, out.why);
  console.log(`  MEASURED: after the victim's own signed update, in census=${inCensus(out, VICTIM)}`);
  assert.equal(inCensus(out, VICTIM), true, 'the victim\'s own signed update could not undo the stranger\'s unsigned step-out');
});

