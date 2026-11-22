// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 a44 refute 86 skeptic 2 (kanban #1836 fix facd00cc5 + #2190 e57b95b35): a STRANGER puts a stepped-out node back in the census.
// An advertisement update is "marker dust + OP_RETURN ARN 'A' bond_outpoint H(advert) + signed body in the witness" (advert-update.js).
// The node's signature covers only advertId(body): not the bond outpoint, not a height, not a sequence; the carrier input is anyone's.
// So any signed body the node ever published (its seat's own 6-hourly check, serving = true; or the bond's own creation body) can be
// copied off the chain and re-posted by anyone, in a fresh transaction, as a NEWER update of the node's bond. newestUpdates keeps the
// newest by height/position and never compares the body's own timestamp, so the replay wins: the census reads serving = true, and the
// seat's inForceOf reads the same record and its next check / roles change / Add to bond re-signs serving = true for good.
// The #1836/#727 effect (a node the operator stepped out is back in every census, never asked) - reached by a stranger, no seat bug needed.
// The mirror also works: an old step-out (serving = false) replayed takes a serving node out of every census (a DoS on any node that
// ever stepped out once).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { newestUpdates } from '../../arena-protocol/src/advert-update.js';
import { newestPerNode } from '../../arena-protocol/src/census.js';
import { advertId } from '../../arena-protocol/src/advert.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { advertUpdateTransaction, bondTransaction } from '../../arena-protocol/tools/bond.js';
import { inForceOf } from '../src/add-bond-wallet.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const hexOf = (b) => Buffer.from(b).toString('hex');
const display = (internal) => hexOf(Uint8Array.from(internal).reverse());
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const SECRET = b32(0x41);
const NODE = schnorr.getPublicKey(SECRET);
const advert = (over) => ({
  nodePubkey: NODE, operatorId: 'op-seat7', protocolVersions: [19], hostedGames: [], roles: ['game', 'verify'],
  endpoint: 'wss://seat7.invalid/', region: 'eu', capacityClass: 1, softwareHash: b32(2),
  settlementCapabilities: 0, lightningCapabilities: 0, bondTxid: new Uint8Array(32), bondVout: 0,
  bondScriptTemplateVersion: 1, payoutPubkey: b32(3), guardianOf: [], guardianCapable: false, guardianEndpoint: '', ...over,
});
const sign = (a) => schnorr.sign(advertId(a), SECRET);

const BOND_BODY = advert({ timestamp: 1000n });
const BOND_TX = bondTransaction(BOND_BODY, { value: 50000, signature: sign(BOND_BODY) });
const BOND_TXID = parseTransaction(BOND_TX).txid;
const CHECK = advert({ timestamp: 2000n });                   // the seat's own check, serving
const STEP_OUT = advert({ timestamp: 3000n, serving: false }); // the operator's step-out, the newest the NODE ever signed
const CHECK_SIG = sign(CHECK), STEP_SIG = sign(STEP_OUT);
const upd = (a, sig, prev) => advertUpdateTransaction(a, { bondTxid: BOND_TXID, bondVout: 0, signature: sig, previousTxid: b32(prev) });

// heights 100 (bond) .. 103; the stranger needs only bytes already on chain (body + signature) and a coin of his own (prev 0xee)
function chain(blocks) { return { firstHeight: 100, blocks: blocks.map((transactions) => ({ transactions })) }; }
function censusServing(view, atHeight) {
  const entry = { txid: BOND_TXID, vout: 0, height: 100, pubkey: NODE, advert: BOND_BODY };
  const updates = newestUpdates(view, [entry], { atHeight, verify });
  const d = newestPerNode([entry], updates).get(`${hexOf(NODE)}|op-seat7`);
  const a = d.u ? d.u.advert : d.own.advert;
  return { serving: a.serving !== false, ts: a.timestamp, u: d.u };
}

test('wf1489-a44-refute-86-s2-1: a stranger re-posts the seat\'s own old check after the step-out - the node is back in the census', () => {
  const honest = chain([[BOND_TX], [upd(CHECK, CHECK_SIG, 0xa1)], [upd(STEP_OUT, STEP_SIG, 0xa2)]]);
  assert.equal(censusServing(honest, 102).serving, false, 'honest path: stepped out at 102');
  const REPLAY = upd(CHECK, CHECK_SIG, 0xee);   // the stranger's own carrier, the node's old signed body
  const attacked = chain([[BOND_TX], [upd(CHECK, CHECK_SIG, 0xa1)], [upd(STEP_OUT, STEP_SIG, 0xa2)], [REPLAY]]);
  const c = censusServing(attacked, 103);
  // the seat's view (regtest-bond bondsOf would carry the same newest update as updatedBy)
  const rec = { txid: display(BOND_TXID), vout: 0, height: 100, sats: 50000, bondAdvert: BOND_BODY,
    advert: c.u ? c.u.advert : BOND_BODY, updatedBy: c.u ? { txid: display(c.u.txid), height: c.u.height, position: c.u.position } : undefined };
  const seat = inForceOf([rec]);
  console.log(`  MEASURED: census at 103 serving=${c.serving} (body timestamp ${c.ts}, newest the node signed is 3000); seat inForceOf serving=${seat.advert.serving !== false}`);
  assert.equal(c.serving, false, 'a replayed older body (timestamp 2000 < step-out 3000) put the stepped-out node back in the census, never asked');
  assert.equal(seat.advert.serving === false, true, 'the seat reads the replay as in force and its next post re-signs serving = true');
});

test('wf1489-a44-refute-86-s2-1b: a stranger replays the bond\'s own creation body as an update - the node is back in', () => {
  // the creation body + its signature are in the bond transaction's witness for anyone to read
  const REPLAY = upd(BOND_BODY, sign(BOND_BODY) /* = the bytes on chain */, 0xef);
  const attacked = chain([[BOND_TX], [upd(STEP_OUT, STEP_SIG, 0xa2)], [REPLAY]]);
  const c = censusServing(attacked, 102);
  console.log(`  MEASURED: census at 102 serving=${c.serving} (body timestamp ${c.ts})`);
  assert.equal(c.serving, false, 'the creation body replayed as an update undid the step-out');
});

test('wf1489-a44-refute-86-s2-1c: the mirror - an old step-out replayed takes a node that came back out of every census', () => {
  const BACK = advert({ timestamp: 4000n });   // the operator stepped back in after the step-out
  const attacked = chain([[BOND_TX], [upd(STEP_OUT, STEP_SIG, 0xa2)], [upd(BACK, sign(BACK), 0xa3)], [upd(STEP_OUT, STEP_SIG, 0xee)]]);
  const c = censusServing(attacked, 103);
  console.log(`  MEASURED: census at 103 serving=${c.serving} (body timestamp ${c.ts}, newest the node signed is 4000)`);
  assert.equal(c.serving, true, 'a replayed step-out (timestamp 3000 < 4000) took a serving node out of the census');
});
