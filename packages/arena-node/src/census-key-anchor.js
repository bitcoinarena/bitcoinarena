// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CENSUS KEY'S ANCHOR, FROM THIS NODE'S OWN WALLET (5A.3B, kanban #1041 answers 1 and 3). Two transactions, as a bond's carrier: the wallet funds a one-leaf output, and spending it
// shows the body as witness items of at most 80 bytes, one OP_DROP each, beside OP_RETURN "ARN" 'K' H(record). The same duty_post settings and fee rates as a day's posting, and a
// node that cannot pay says so and falls to the next. The carrier's key is thrown away: it holds what the reveal pays in fees and no more.
import { schnorr } from '@noble/curves/secp256k1.js';
import { TAPLEAF_VERSION, tapLeafHash, tapTweak } from '../../arena-protocol/src/bond-script.js';
import { tapSighash, scriptPathWitness, serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { censusKeyAnchor, censusKeyBodyPieces } from '../../arena-protocol/src/census-key.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';
import { tweakPoint } from './curve.js';
import { fundAtRate } from './fund-at-rate.js';
import { dutySetting, walletVerdict } from './duty-poster.js';

const DUST = 330n;
const le64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

/** One leaf that drops `drops` items and checks one signature, and its taproot output. */
export function censusKeyCarrier(secret, drops) {
  const key = schnorr.getPublicKey(secret);
  const script = Uint8Array.from([...new Array(drops).fill(0x75), 0x20, ...key, 0xac]);
  const leaf = tapLeafHash(script);
  const { outputKey, parity } = tweakPoint(key, tapTweak(key, leaf));
  return { script, leaf, spk: fromHex(`5120${toHex(outputKey)}`), control: Uint8Array.from([TAPLEAF_VERSION | parity, ...key]) };
}

/** The spend of a funded carrier: the anchor as its only output, so all it holds is the fee. `funding` { txid as bitcoind prints it, vout, value }. Answers the raw bytes. */
export function censusKeyAnchorSpend({ carrier, secret, pieces, funding, record }) {
  const inputs = [{ txid: fromHex(funding.txid).reverse(), vout: funding.vout, sequence: 0xfffffffe }];
  const outputs = [censusKeyAnchor(record)];
  const sighash = tapSighash({ version: 2, locktime: 0, inputs, outputs, prevouts: [{ value: funding.value, script: carrier.spk }], inputIndex: 0, leafHash: carrier.leaf });
  return serializeSpend({ version: 2, locktime: 0, inputs, outputs,
    witnesses: [scriptPathWitness({ stack: [schnorr.sign(sighash, secret), ...pieces], script: carrier.script, controlBlock: carrier.control })] });
}

/**
 * `post({ body, record })` -> { ok, txid, vsize, fee } or { ok: false, why }. `call` the node's bitcoind, `walletCall(name)` a wallet's; `env` ARENA_DUTY_POST, ARENA_DUTY_WALLET,
 * ARENA_DUTY_FEE_RATE, as the day's posting reads them.
 */
export function createCensusKeyPoster({ call, walletCall, env = {} }) {
  const setting = dutySetting(env.ARENA_DUTY_POST);
  const feeRate = Number(env.ARENA_DUTY_FEE_RATE || 0.1);
  return async function post({ body, record }) {
    if (setting === 'off') return { ok: false, why: 'round posting is off (duty_post=off)' };
    let listed; try { listed = await call('listwallets', []); } catch (e) { listed = e; }
    const named = String(env.ARENA_DUTY_WALLET || '').trim();
    const pre = walletVerdict({ listed, named, unspent: [] });
    if (!pre.wallet || listed instanceof Error) return { ok: false, why: pre.why };
    const rpc = walletCall(pre.wallet);
    let unspent; try { unspent = await rpc('listunspent', [1, 9999999, [], false]); } catch (e) { unspent = e; }
    const wallet = walletVerdict({ listed, named, unspent });
    if (!wallet.canPay) return { ok: false, why: wallet.why };
    try {
      const secret = schnorr.utils.randomSecretKey();
      const pieces = censusKeyBodyPieces(body);
      const carrier = censusKeyCarrier(secret, pieces.length);
      const sized = await call('decoderawtransaction', [toHex(censusKeyAnchorSpend({ carrier, secret, pieces, funding: { txid: '00'.repeat(32), vout: 0, value: 100000n }, record }))]);
      const fee = BigInt(Math.ceil(sized.vsize * feeRate));
      const value = fee > DUST ? fee : DUST;
      const funded = await fundAtRate(rpc, [Buffer.concat([le64(value), Buffer.from([carrier.spk.length]), Buffer.from(carrier.spk)])], feeRate);
      const txid = String(await rpc('sendrawtransaction', [funded.hex]));
      const reveal = censusKeyAnchorSpend({ carrier, secret, pieces, funding: { txid, vout: 0, value }, record });
      const sent = String(await rpc('sendrawtransaction', [toHex(reveal)]));
      return { ok: true, txid: sent, vsize: sized.vsize, fee: String(value + funded.fee) };
    } catch (e) { return { ok: false, why: e.message.slice(0, 200) }; }
  };
}
