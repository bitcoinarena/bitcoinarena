// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE'S BOND, FROM ITS OWN WALLET (and slice 2; 2026-10-18: "giving an address on the newly created
// bitcoin wallet where the bond is first transferred to so the node can post the bond", and the owner section: "verifying that the bond
// has been posted, withdrawing the bond after the lock (communicating the lock time clearly) and also increasing the bond size").
//
// The same construction the testnet4 seats were bonded with (arena-node/tools/regtest-bond.mjs postBond, template 2, §5A.3B), without a
// bitcoind wallet: two transactions, broadcast together (the second spends the first from the mempool):
//   1. FUNDING  the wallet's coins (wallet.js, BIP86 key path) into a carrier output whose script drops the advertisement's pieces;
//   2. BOND     the carrier spent with the signed advertisement in its witness, into the bond output (the node's key, its maturity
//               height, the arbitration keys), the network's marker, the commitment to the advertisement and the change.
// The carrier's key comes from the wallet key and the advertisement's id, so coins stuck in a carrier are recovered from the 24 words.
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { bondOutputKey, bondInternalKey, tapLeafHash, TAPLEAF_VERSION, maturityHeightFor, BOND_TEMPLATE_V2, BOND_MATURITY_OFFSET, recoveryLeaf, controlBlockFor } from '../../arena-protocol/src/bond-script.js';
import { tapSighash, scriptPathWitness, serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { encodeAdvert, advertId, joinSignedAdvert } from '../../arena-protocol/src/advert.js';
import { advertUpdatePayload } from '../../arena-protocol/src/advert-update.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { bondMarker, SUPPORTED_PROTOCOL_VERSIONS } from '../../arena-protocol/src/constants.js';
import { toHex, fromHex, taggedHash, sha256 } from '../../arena-protocol/src/hash.js';
import { tweakPoint, combine } from '../../arena-node/src/curve.js';

export const NETWORK = 'testnet4';
/** The census minimum the testnet4 rounds name (§27A.2 lowest bracket, ARENA_LOWEST_BOND_MIN_SATS): 50,000 sat. */
export const BOND_MIN_SATS = 50000n;
export const MARKER_SATS = 330n;
export const CARRIER_TAG = 'arena/node-carrier/v1';
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;   // the secp256k1 group order
const CHUNK = 80;
/** Testnet4's blocks, for saying when a height is reached: ten minutes each (often faster: the date is an estimate, the height is the rule). */
export const BLOCK_MS = 600000;

/**
 * NEXT BLOCK'S GAME ID, the one game every node's advertisement names (hostedGames). A constant, not an import of the app: a release no
 * longer carries the apps (kanban #575) - they are downloaded after the installer starts - so nothing here may import one. test/bond.test.js
 * checks it is the id of the Next Block the Arena pins.
 */
export const NEXTBLOCK_GAME_ID = fromHex('495516ae59539661062cd72fd8716afbb378bd386297ab09b20aba0a2cd44150');

/**
 * THE BLOCKS A BOND MAY WAIT TO CONFIRM. A bond counts in the census only when its maturity is at least its confirmation height plus the
 * network's offset (bond-script.js); the protocol's own default leaves 6 blocks for that. Measured on testnet4 2026-10-19: seven bonds
 * posted while an empty-block bot held the chain confirmed 23 blocks after they were built, T2's four 14 blocks after - all eleven locked
 * and never counted; two installer bonds counted with no block to spare. A day of slack (the lock a day longer) covers a stalled chain or a
 * full mempool.
 */
export const BOND_SLACK_BLOCKS = 144;
const maturityAfter = (tip) => maturityHeightFor(tip, NETWORK, { slackBlocks: BOND_SLACK_BLOCKS });

/** A confirmed bond's standing in the census: { counts, short } - short the blocks its maturity misses confirmation + offset by. */
export function bondCounts({ maturity, confirmedAt, network = NETWORK }) {
  const want = confirmedAt + BOND_MATURITY_OFFSET[network];
  return { counts: maturity >= want, short: Math.max(0, want - maturity) };
}

/** The lock, said plainly: the maturity height for a bond confirmed after `tip`, the blocks until then and an estimated date. */
export function lockOf(tip, { nowMs = Date.now(), maturity = maturityAfter(tip) } = {}) {
  const blocks = Math.max(0, maturity - tip);
  return { maturity, blocks, offset: BOND_MATURITY_OFFSET[NETWORK], estimatedMs: nowMs + blocks * BLOCK_MS };
}

/** The node's roles as its advertisement names them: the wizard's verify is game + verify (§5A.1 roles). Custody is said by the guardian
 *  endpoint, liquidity by the provider's own signed claim (GET /liquidity-claim, §23A.10) - neither is an advertisement role (measured on
 *  macOS node A,: a liquidity node's bond was refused, "unknown role: liquidity"). */
export const advertRoles = (roles) => [...new Set(roles.flatMap((r) => (r === 'verify' ? ['game', 'verify'] : [r])))].filter((r) => r !== 'custody' && r !== 'liquidity');

/** The bond output key of a node key at a maturity height (template 2). */
export function bondKeyAt(nodeKey, maturity) {
  const g = genesisFor(NETWORK);
  return bondOutputKey({ nodeKey, arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK, bondMaturity: maturity,
    internalKey: bondInternalKey({ nodeKey, arbitrationKeys: g.arbitrationKeys }, { combine }).internalKey }, { tweakPoint, combine });
}

/**
 * THE OWNER'S EMERGENCY KEY IN THE ADVERT (§23A.5a, protocol 17) - only once every seat reads it: a seat before protocol 17 refuses an
 * advertisement with the field ("trailing bytes"), so a bond posted with it too early is in no census. Since 2026-10-19 19:33Z all 14
 * testnet4 seats run protocol 18 (kanban #525, #528), so it is on; ARENA_EMERGENCY_ADVERT=0 leaves it out (a network whose seats are older).
 */
export const EMERGENCY_IN_ADVERT = process.env.ARENA_EMERGENCY_ADVERT !== '0';

/** The node's advertisement, unsigned. */
export function advertFor({ nodeKey, operatorId, roles, endpoint, payoutPubkey, maturity, softwareHash, guardianEndpoint = null, nowMs = Date.now(), emergencyPubkey = null, guardianOf = [] }) {
  return {
    nodePubkey: nodeKey, operatorId, protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS], roles: advertRoles(roles), hostedGames: [NEXTBLOCK_GAME_ID],
    endpoint, region: 'unknown', capacityClass: 1, softwareHash,
    settlementCapabilities: 0, lightningCapabilities: 0,
    bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: BOND_TEMPLATE_V2, bondMaturityHeight: maturity,
    // a custody node's guardian can be drawn when nodes found a federation (§23A, ruling 3): capable, at its endpoint
    payoutPubkey, guardianOf, guardianCapable: Boolean(guardianEndpoint), guardianEndpoint: guardianEndpoint || '', timestamp: BigInt(nowMs),
    ...(emergencyPubkey ? { emergencyPubkey } : {}),
  };
}

const carrierScript = (key, drops) => Uint8Array.from([...new Array(drops).fill(0x75), 0x20, ...key, 0xac]);
function carrierOf(secret, drops) {
  const key = schnorr.getPublicKey(secret);
  const script = carrierScript(key, drops);
  const leaf = tapLeafHash(script);
  const { outputKey, parity } = tweakPoint(key, taggedHash('TapTweak', new Uint8Array([...key, ...leaf])));
  return { script, leaf, spk: fromHex('5120' + toHex(outputKey)), control: Uint8Array.from([TAPLEAF_VERSION | parity, ...key]) };
}

/** A BIP86 key-path signing key: the wallet secret, even-y, plus the tweak. */
function keyPathSecret(secret, xonly) {
  const d0 = BigInt('0x' + toHex(secret));
  const odd = secp256k1.getPublicKey(secret, true)[0] === 0x03;
  const d = odd ? N - d0 : d0;
  const t = BigInt('0x' + toHex(taggedHash('TapTweak', xonly)));
  return fromHex(((d + t) % N).toString(16).padStart(64, '0'));
}

const cs = (n) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : 5);
/** A transaction's virtual size: (3 x its bytes without the witness + all its bytes) / 4. */
const vsizeOf = (hex) => {
  const raw = fromHex(hex);
  const p = parseTransaction(raw);
  const witnessBytes = p.segwit ? 2 + p.witnesses.reduce((a, w) => a + cs(w.length) + w.reduce((b, item) => b + cs(item.length) + item.length, 0), 0) : 0;
  return Math.ceil((3 * (raw.length - witnessBytes) + raw.length) / 4);
};
const txidOf = (hex) => toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse());

/**
 * Build the two transactions. `coins`: the wallet's ([{ txid, vout, sats }]). `nodeSecret`: the node's own key (its store). Answers
 * { funding: { hex, txid }, bond: { hex, txid, vout: 0 }, advert, maturity, bondSats, changeSats, fees } or throws why not.
 */
export function buildBond({ wallet, nodeSecret, coins, tip, bondSats = BOND_MIN_SATS, operatorId, roles, endpoint, payoutPubkey,
  softwareHash = new Uint8Array(32), feeRate = 2, nowMs = Date.now(), oldBond = null, guardianEndpoint = null, emergencyPubkey = null, guardianOf = [] }) {
  // A LARGER BOND, IN ONE STEP ("increasing the bond size"; a template-2 bond cannot be topped up in place):
  // `oldBond` { txid, vout, sats, maturity } - from its maturity on - is the funding's first input, spent on its recovery leaf by the
  // node's key (the transaction's locktime is that maturity), and the wallet's coins add the rest; the new bond is built as any
  // other, with a new maturity. One step: the old bond is never back in the wallet in between.
  if (oldBond && !(tip >= oldBond.maturity)) throw new Error(`the bond is locked until block ${oldBond.maturity}: ${oldBond.maturity - tip} blocks from now`);
  if (!coins.length && !oldBond) throw new Error('the wallet holds no coins yet');
  const nodeKey = schnorr.getPublicKey(nodeSecret);
  const maturity = maturityAfter(tip);
  const advert = advertFor({ nodeKey, operatorId, roles, endpoint, payoutPubkey, maturity, softwareHash, guardianEndpoint, nowMs, emergencyPubkey, guardianOf });
  const id = advertId(advert);
  const body = joinSignedAdvert(encodeAdvert(advert), schnorr.sign(id, nodeSecret));
  const pieces = []; for (let at = 0; at < body.length; at += CHUNK) pieces.push(body.subarray(at, Math.min(at + CHUNK, body.length)));
  const carrierSecret = taggedHash(CARRIER_TAG, new Uint8Array([...wallet.secret, ...id]));
  const carrier = carrierOf(carrierSecret, pieces.length);
  const total = coins.reduce((a, c) => a + BigInt(c.sats), 0n) + (oldBond ? BigInt(oldBond.sats) : 0n);
  const old = oldBond ? (() => { const built = bondKeyAt(nodeKey, oldBond.maturity); return { built, spk: fromHex('5120' + toHex(built.outputKey)), leaf: recoveryLeaf(nodeKey, oldBond.maturity) }; })() : null;
  const bondOut = bondKeyAt(nodeKey, maturity);
  const kp = keyPathSecret(wallet.secret, wallet.xonly);

  // the bond transaction first (its size sets what the carrier must hold), then the funding at its own fee
  const bondTx = (carrierValue, fundingTxid, fee) => {
    const change = carrierValue - bondSats - MARKER_SATS - fee;
    const outputs = [
      { value: bondSats, script: fromHex('5120' + toHex(bondOut.outputKey)) },
      { value: MARKER_SATS, script: fromHex('5120' + toHex(bondMarker(NETWORK))) },
      { value: 0n, script: Uint8Array.from([0x6a, 0x20, ...id]) },
      ...(change >= 330n ? [{ value: change, script: wallet.spk }] : []),
    ];
    const inputs = [{ txid: fromHex(fundingTxid).reverse(), vout: 0, sequence: 0xfffffffe }];
    const sighash = tapSighash({ version: 2, locktime: 0, inputs, outputs, prevouts: [{ value: carrierValue, script: carrier.spk }], inputIndex: 0, leafHash: carrier.leaf });
    const hex = toHex(serializeSpend({ version: 2, locktime: 0, inputs, outputs,
      witnesses: [scriptPathWitness({ stack: [schnorr.sign(sighash, carrierSecret), ...pieces], script: carrier.script, controlBlock: carrier.control })] }));
    return { hex, change: change >= 330n ? change : 0n };
  };
  const fundingTx = (carrierValue) => {
    const inputs = [...(oldBond ? [{ txid: fromHex(oldBond.txid).reverse(), vout: oldBond.vout, sequence: 0xfffffffe }] : []),
      ...coins.map((c) => ({ txid: fromHex(c.txid).reverse(), vout: c.vout, sequence: 0xfffffffd }))];
    const prevouts = [...(oldBond ? [{ value: BigInt(oldBond.sats), script: old.spk }] : []), ...coins.map((c) => ({ value: BigInt(c.sats), script: wallet.spk }))];
    const outputs = [{ value: carrierValue, script: carrier.spk }];
    const locktime = oldBond ? oldBond.maturity : 0;
    const witnesses = inputs.map((_, i) => (oldBond && i === 0
      ? scriptPathWitness({ stack: [schnorr.sign(tapSighash({ version: 2, locktime, inputs, outputs, prevouts, inputIndex: 0, leafHash: tapLeafHash(old.leaf) }), nodeSecret)],
        script: old.leaf, controlBlock: controlBlockFor('recovery', old.built).controlBlock })
      : [schnorr.sign(tapSighash({ version: 2, locktime, inputs, outputs, prevouts, inputIndex: i }), kp)]));
    return toHex(serializeSpend({ version: 2, locktime, inputs, outputs, witnesses }));
  };
  // sizes from a first build, then the fees at feeRate sat/vB (rounded up, 1 sat/vB at least above the relay floor)
  const rate = BigInt(Math.max(1, Math.ceil(feeRate)));
  let feeBond = 1000n, feeFund = 300n;
  for (let pass = 0; pass < 2; pass++) {
    const carrierValue = total - feeFund;
    const f = fundingTx(carrierValue);
    const b = bondTx(carrierValue, txidOf(f), feeBond);
    feeFund = BigInt(vsizeOf(f)) * rate + 10n;
    feeBond = BigInt(vsizeOf(b.hex)) * rate + 10n;
  }
  const carrierValue = total - feeFund;
  if (carrierValue - feeBond < bondSats + MARKER_SATS) throw new Error(`${oldBond ? 'the old bond and the wallet hold' : 'the wallet holds'} ${total} sat: a bond of ${bondSats} sat needs at least ${bondSats + MARKER_SATS + feeBond + feeFund} sat`);
  const funding = fundingTx(carrierValue);
  const fundingTxid = txidOf(funding);
  const b = bondTx(carrierValue, fundingTxid, feeBond);
  return { funding: { hex: funding, txid: fundingTxid }, bond: { hex: b.hex, txid: txidOf(b.hex), vout: 0 }, advert, advertId: toHex(id),
    maturity, bondSats, changeSats: b.change, fees: { funding: feeFund, bond: feeBond }, nodeKey: toHex(nodeKey) };
}

/**
 * AN ADVERTISEMENT UPDATE OF THE NODE'S BOND (§5A.2;: a custody node's guardian_of[] once its federation is
 * founded, published by itself): two transactions as the bond's - the wallet's coins to a carrier, then the carrier to the bond marker,
 * OP_RETURN "ARN" 'A' bond outpoint H(advertisement) and the change back to the wallet, the advertisement signed by the node's key in
 * the carrier's witness. It spends no bond and starts no maturity clock. `bond` { txid (hex as Bitcoin Core shows it), vout }.
 * Answers { funding: { hex, txid }, update: { hex, txid }, advertId, changeSats, fees }.
 */
export function buildAdvertUpdate({ wallet, nodeSecret, coins, bond, advert, feeRate = 2 }) {
  if (!coins.length) throw new Error('the wallet holds no coins for the advertisement update');
  const nodeKey = schnorr.getPublicKey(nodeSecret);
  if (toHex(advert.nodePubkey) !== toHex(nodeKey)) throw new Error('an update names the node key that signs it');
  const id = advertId(advert);
  const body = joinSignedAdvert(encodeAdvert(advert), schnorr.sign(id, nodeSecret));
  const pieces = []; for (let at = 0; at < body.length; at += CHUNK) pieces.push(body.subarray(at, Math.min(at + CHUNK, body.length)));
  const carrierSecret = taggedHash(CARRIER_TAG, new Uint8Array([...wallet.secret, ...id]));
  const carrier = carrierOf(carrierSecret, pieces.length);
  const kp = keyPathSecret(wallet.secret, wallet.xonly);
  const total = coins.reduce((a, c) => a + BigInt(c.sats), 0n);
  const payload = advertUpdatePayload({ bondTxid: fromHex(bond.txid).reverse(), bondVout: bond.vout, advertIdBytes: id });
  const updateTx = (carrierValue, fundingTxid, fee) => {
    const change = carrierValue - MARKER_SATS - fee;
    const outputs = [{ value: MARKER_SATS, script: fromHex('5120' + toHex(bondMarker(NETWORK))) }, { value: 0n, script: Uint8Array.from([0x6a, payload.length, ...payload]) },
      ...(change >= 330n ? [{ value: change, script: wallet.spk }] : [])];
    const inputs = [{ txid: fromHex(fundingTxid).reverse(), vout: 0, sequence: 0xfffffffe }];
    const sighash = tapSighash({ version: 2, locktime: 0, inputs, outputs, prevouts: [{ value: carrierValue, script: carrier.spk }], inputIndex: 0, leafHash: carrier.leaf });
    return { hex: toHex(serializeSpend({ version: 2, locktime: 0, inputs, outputs,
      witnesses: [scriptPathWitness({ stack: [schnorr.sign(sighash, carrierSecret), ...pieces], script: carrier.script, controlBlock: carrier.control })] })), change: change >= 330n ? change : 0n };
  };
  const fundingTx = (carrierValue) => {
    const inputs = coins.map((c) => ({ txid: fromHex(c.txid).reverse(), vout: c.vout, sequence: 0xfffffffd }));
    const prevouts = coins.map((c) => ({ value: BigInt(c.sats), script: wallet.spk }));
    const outputs = [{ value: carrierValue, script: carrier.spk }];
    const witnesses = inputs.map((_, i) => [schnorr.sign(tapSighash({ version: 2, locktime: 0, inputs, outputs, prevouts, inputIndex: i }), kp)]);
    return toHex(serializeSpend({ version: 2, locktime: 0, inputs, outputs, witnesses }));
  };
  const rate = BigInt(Math.max(1, Math.ceil(feeRate)));
  let feeUpd = 800n, feeFund = 300n;
  for (let pass = 0; pass < 2; pass++) {
    const f = fundingTx(total - feeFund);
    const u = updateTx(total - feeFund, txidOf(f), feeUpd);
    feeFund = BigInt(vsizeOf(f)) * rate + 10n; feeUpd = BigInt(vsizeOf(u.hex)) * rate + 10n;
  }
  if (total - feeFund - feeUpd < MARKER_SATS) throw new Error(`the wallet holds ${total} sat: an advertisement update needs at least ${MARKER_SATS + feeFund + feeUpd} sat`);
  const funding = fundingTx(total - feeFund);
  const u = updateTx(total - feeFund, txidOf(funding), feeUpd);
  return { funding: { hex: funding, txid: txidOf(funding) }, update: { hex: u.hex, txid: txidOf(u.hex) }, advertId: toHex(id), changeSats: u.change, fees: { funding: feeFund, update: feeUpd } };
}

/** A payment from the wallet (the custody peg-in): `sats` to `script`, the rest back to the wallet. Answers { hex, txid, fee, changeSats }. */
export function buildSend({ wallet, coins, script, sats, feeRate = 2 }) {
  const want = BigInt(sats);
  const kp = keyPathSecret(wallet.secret, wallet.xonly);
  const total = coins.reduce((a, c) => a + BigInt(c.sats), 0n);
  const tx = (fee) => {
    const change = total - want - fee;
    const inputs = coins.map((c) => ({ txid: fromHex(c.txid).reverse(), vout: c.vout, sequence: 0xfffffffd }));
    const prevouts = coins.map((c) => ({ value: BigInt(c.sats), script: wallet.spk }));
    const outputs = [{ value: want, script }, ...(change >= 330n ? [{ value: change, script: wallet.spk }] : [])];
    const witnesses = inputs.map((_, i) => [schnorr.sign(tapSighash({ version: 2, locktime: 0, inputs, outputs, prevouts, inputIndex: i }), kp)]);
    return { hex: toHex(serializeSpend({ version: 2, locktime: 0, inputs, outputs, witnesses })), change: change >= 330n ? change : 0n };
  };
  const rate = BigInt(Math.max(1, Math.ceil(feeRate)));
  let fee = 300n;
  for (let pass = 0; pass < 2; pass++) fee = BigInt(vsizeOf(tx(fee).hex)) * rate + 10n;
  if (total < want + fee) throw new Error(`the wallet holds ${total} sat: sending ${want} sat needs ${want + fee} sat`);
  const t = tx(fee);
  return { hex: t.hex, txid: txidOf(t.hex), fee, changeSats: t.change };
}

export { sha256 };
