// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CENSUS KEY'S ANCHORS, FROM THIS NODE'S OWN WALLET (5A.3B, kanban #1041 answers 1 and 3, #1048). Two transactions, as a bond's carrier: the wallet funds a one-leaf output whose leaf
// holds the body (census-key.js censusKeyEnvelope), and spending it reveals the leaf beside OP_RETURN "ARN" 'K' H(record) or "ARN" 'R' H(list). The output commits to the leaf, so no relay can
// take the body off. The same duty_post settings and fee rates as a day's posting, and a node that cannot pay says so and falls to the next. The carrier's key is thrown away: it holds what the
// reveal pays in fees and no more.
import { schnorr } from '@noble/curves/secp256k1.js';
import { TAPLEAF_VERSION, tapLeafHash, tapTweak } from '../../arena-protocol/src/bond-script.js';
import { tapSighash, scriptPathWitness, serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { censusKeyEnvelope } from '../../arena-protocol/src/census-key.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';
import { tweakPoint } from './curve.js';
import { fundAtRate } from './fund-at-rate.js';
import { dutySetting, walletVerdict } from './duty-poster.js';

const DUST = 330n;
const le64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

/** One leaf that checks one signature and holds the body, and its taproot output. */
export function censusKeyCarrier(secret, body) {
  const key = schnorr.getPublicKey(secret);
  const script = Uint8Array.from([0x20, ...key, 0xac, ...censusKeyEnvelope(body)]);
  const leaf = tapLeafHash(script);
  const { outputKey, parity } = tweakPoint(key, tapTweak(key, leaf));
  return { script, leaf, spk: fromHex(`5120${toHex(outputKey)}`), control: Uint8Array.from([TAPLEAF_VERSION | parity, ...key]) };
}

/** The spend of a funded carrier: `output` the anchor as its only output, so all it holds is the fee. `funding` { txid as bitcoind prints it, vout, value }. Answers the raw bytes. */
export function censusKeyAnchorSpend({ carrier, secret, funding, output }) {
  const inputs = [{ txid: fromHex(funding.txid).reverse(), vout: funding.vout, sequence: 0xfffffffe }];
  const outputs = [output];
  const sighash = tapSighash({ version: 2, locktime: 0, inputs, outputs, prevouts: [{ value: funding.value, script: carrier.spk }], inputIndex: 0, leafHash: carrier.leaf });
  return serializeSpend({ version: 2, locktime: 0, inputs, outputs,
    witnesses: [scriptPathWitness({ stack: [schnorr.sign(sighash, secret)], script: carrier.script, controlBlock: carrier.control })] });
}

/**
 * A COIN THAT HOLDS A FEE, FROM THE SAME WALLET (kanban #972): `fund(spk, value)` -> { ok, txid, vout, value } or { ok: false, why }. A slash start takes a fee input whoever files it, so a node that can pay for an anchor can file.
 */
export function createFeeCoin({ call, walletCall, env = {} }) {
  const setting = dutySetting(env.ARENA_DUTY_POST);
  const feeRate = Number(env.ARENA_DUTY_FEE_RATE || 0.1);
  const named = String(env.ARENA_DUTY_WALLET || '').trim();
  async function fund(spk, value) {
    if (setting === 'off') return { ok: false, why: 'round posting is off (duty_post=off), and that wallet pays this too' };
    let listed; try { listed = await call('listwallets', []); } catch (e) { listed = e; }
    const pre = walletVerdict({ listed, named, unspent: [] });
    if (!pre.wallet || listed instanceof Error) return { ok: false, why: pre.why };
    const rpc = walletCall(pre.wallet);
    let unspent; try { unspent = await rpc('listunspent', [1, 9999999, [], false]); } catch (e) { unspent = e; }
    const wallet = walletVerdict({ listed, named, unspent });
    if (!wallet.canPay) return { ok: false, why: wallet.why };
    let funded;
    try { funded = await fundAtRate(rpc, [Buffer.concat([le64(value), Buffer.from([spk.length]), Buffer.from(spk)])], feeRate); } catch (e) { return { ok: false, why: e.message.slice(0, 200) }; }
    // A SEND WHOSE ANSWER IS LOST MAY HAVE GONE OUT (kanban #1191): `unknown`, so the starter looks for it (find) before it funds again
    try { return { ok: true, txid: String(await rpc('sendrawtransaction', [funded.hex])), vout: 0, value: BigInt(value) }; } catch (e) { return { ok: false, unknown: true, why: e.message.slice(0, 200) }; }
  }
  /**
   * THE COIN THIS WALLET FUNDED AT `spk`, if any (kanban #1191): its recent sends, each read whole - { txid, vout, value } or null. A coin this wallet funded is one of
   * its own sends, in the mempool or a block; one the wallet abandoned or a block took away is not there, and is funded again.
   */
  fund.find = async (spk) => {
    let listed; try { listed = await call('listwallets', []); } catch (e) { throw new Error(`no wallet list: ${e.message}`); }
    const pre = walletVerdict({ listed, named, unspent: [] });
    if (!pre.wallet) throw new Error(pre.why || 'no wallet');
    const rpc = walletCall(pre.wallet), want = toHex(spk);
    const sends = [...new Set((await rpc('listtransactions', ['*', 500, 0, true])).filter((t) => t.category === 'send' && Number(t.confirmations) >= 0 && !t.abandoned).map((t) => t.txid))];
    for (const txid of sends.reverse()) {
      const t = await rpc('gettransaction', [txid, true, true]);
      if (Number(t.confirmations) < 0 || !t.decoded) continue;
      const out = t.decoded.vout.find((o) => o.scriptPubKey && o.scriptPubKey.hex === want);
      if (out) return { txid, vout: out.n, value: BigInt(Math.round(Number(out.value) * 1e8)) };
    }
    return null;
  };
  return fund;
}

/**
 * `post({ body, output })` -> { ok, txid, vsize, fee } or { ok: false, why }. `output` is the OP_RETURN that names the body. `call` the node's bitcoind, `walletCall(name)` a wallet's; `env` ARENA_DUTY_POST, ARENA_DUTY_WALLET,
 * ARENA_DUTY_FEE_RATE, as the day's posting reads them.
 */
export function createCensusKeyPoster({ call, walletCall, env = {} }) {
  const setting = dutySetting(env.ARENA_DUTY_POST);
  const feeRate = Number(env.ARENA_DUTY_FEE_RATE || 0.1);
  return async function post({ body, output }) {
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
      const carrier = censusKeyCarrier(secret, body);
      const sized = await call('decoderawtransaction', [toHex(censusKeyAnchorSpend({ carrier, secret, funding: { txid: '00'.repeat(32), vout: 0, value: 100000n }, output }))]);
      const fee = BigInt(Math.ceil(sized.vsize * feeRate));
      const value = fee > DUST ? fee : DUST;
      const funded = await fundAtRate(rpc, [Buffer.concat([le64(value), Buffer.from([carrier.spk.length]), Buffer.from(carrier.spk)])], feeRate);
      const txid = String(await rpc('sendrawtransaction', [funded.hex]));
      const reveal = censusKeyAnchorSpend({ carrier, secret, funding: { txid, vout: 0, value }, output });
      const sent = String(await rpc('sendrawtransaction', [toHex(reveal)]));
      return { ok: true, txid: sent, vsize: sized.vsize, fee: String(value + funded.fee) };
    } catch (e) { return { ok: false, why: e.message.slice(0, 200) }; }
  };
}
