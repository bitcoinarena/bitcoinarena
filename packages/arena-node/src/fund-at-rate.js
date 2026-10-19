// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A TRANSACTION FUNDED AND SIGNED BY THE WALLET AT A FEE RATE UNDER ITS OWN FLOOR.
//
// 2026-10-12, "Mach das deutlich sparsamer": a 450-round RPS grid paid 21,000 sat at 1 sat/vB. Bitcoin Core's
// wallet funds at no less than its mintxfee (1 sat/vB, measured on the testnet4 wallet: fundrawtransaction and
// sendtoaddress both refuse 0.1), while the node relays from its minrelaytxfee (0.1 sat/vB on testnet4; peers' feefilters
// 0 / 0.1 / 1 sat/vB). So the coins are chosen here - the wallet's own spendable outputs, largest first - and the wallet
// only signs. The fee is the asked rate times the signed size, rounded up; a change below dust goes to the fee. Every
// input signals replacement, so the wallet's bumpfee can raise it later (awaitPublishedBeacon).
//
//   rpc(method, params)   the wallet's bitcoind RPC
//   outputs               the transaction's outputs, each serialized (8-byte value, script length, script)
//   feeRate               sat/vB
// Returns { hex, fee, vsize } - the signed transaction, its fee in sat and its virtual size.

const DUST = 330n;   // below this a P2TR / P2WPKH change is dust to Bitcoin Core's relay policy (P2TR's floor, the higher)

const le = (n, bytes) => { const b = Buffer.alloc(bytes); if (bytes === 8) b.writeBigUInt64LE(BigInt(n)); else b.writeUIntLE(n, 0, bytes); return b; };
const varint = (n) => (n < 0xfd ? Buffer.from([n]) : n <= 0xffff ? Buffer.concat([Buffer.from([0xfd]), le(n, 2)]) : Buffer.concat([Buffer.from([0xfe]), le(n, 4)]));

/** The unsigned transaction: version 2, the coins (replaceable), the outputs, the change last if any. */
export function serializeUnsigned(coins, outputs, change) {
  const ins = coins.map((c) => Buffer.concat([Buffer.from(c.txid, 'hex').reverse(), le(c.vout, 4), Buffer.from([0]), le(0xfffffffd, 4)]));
  const outs = change ? [...outputs, Buffer.concat([le(change.value, 8), varint(change.script.length), change.script])] : outputs;
  return Buffer.concat([le(2, 4), varint(ins.length), ...ins, varint(outs.length), ...outs, le(0, 4)]).toString('hex');
}

export async function fundAtRate(rpc, outputs, feeRate) {
  if (!(feeRate > 0)) throw new Error('a fee rate is sat/vB above zero');
  const sats = (btc) => BigInt(Math.round(Number(btc) * 1e8));
  const coins = (await rpc('listunspent', [0, 9999999, [], false])).filter((c) => c.spendable && c.safe)
    .sort((a, b) => Number(sats(b.amount) - sats(a.amount)));
  const changeScript = Buffer.from((await rpc('getaddressinfo', [await rpc('getrawchangeaddress', [])])).scriptPubKey, 'hex');
  const sign = async (hex) => {
    const s = await rpc('signrawtransactionwithwallet', [hex]);
    if (!s.complete) throw new Error(`the wallet did not sign the transaction: ${JSON.stringify(s.errors || [])}`);
    return { hex: s.hex, vsize: (await rpc('decoderawtransaction', [s.hex])).vsize };
  };
  const chosen = [];
  let have = 0n;
  for (const c of coins) {
    chosen.push(c); have += sats(c.amount);
    // THE SIZE WITH A CHANGE OUTPUT, signed once to read it (a witness is not in the unsigned bytes)
    const { vsize } = await sign(serializeUnsigned(chosen, outputs, { value: 0n, script: changeScript }));
    const fee = BigInt(Math.ceil(vsize * feeRate));
    if (have < fee) continue;
    const change = have - fee;
    if (change >= DUST) {
      const signed = await sign(serializeUnsigned(chosen, outputs, { value: change, script: changeScript }));
      return { hex: signed.hex, fee, vsize: signed.vsize };
    }
    const signed = await sign(serializeUnsigned(chosen, outputs, null));
    return { hex: signed.hex, fee: have, vsize: signed.vsize };
  }
  throw new Error(`the wallet's ${coins.length} spendable coins (${have} sat) do not pay ${outputs.length} outputs at ${feeRate} sat/vB`);
}
