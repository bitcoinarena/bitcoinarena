#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FAKE bitcoin-cli FOR THE TESTNET4 TOOLS' TESTS: no node, no wallet, no network. Every call is appended to
// $FAKE_CLI_LOG as one JSON line { args }; each method answers from the JSON spec at $FAKE_CLI_SPEC:
//   { mtp: { "<height>": <seconds> }, tip: { blocks, mediantime }, utxos: [...], input: { txid, vout }, mempool: { allowed, reason },
//     send: "<txid>" | true (the sent transaction's own txid) | null (sendrawtransaction fails), fail: { "<method>": "<message>" },
//     wallets: [...], scan: { "<descriptor>": [unspents] }, raw: { "<txid>": "<hex>" }, txout: { "<txid>:<vout>": { value } },
//     signs: false (finalizepsbt answers incomplete), refuse: { "<index into testmempoolaccept's list>": "<reason>" } }
// Real transaction hex is decoded for real (arena-protocol/src/tx.js), and walletcreatefundedpsbt builds a real unsigned
// transaction spending exactly the inputs it was given (decodescript's "address" is the script itself, addr:<hex>).
// A method not listed exits 1 with its name, so a tool reaching for something new is seen, not silently answered.
import { appendFileSync, readFileSync } from 'node:fs';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
const args = process.argv.slice(2).filter((a) => !/^-(datadir|rpcwallet|rpcport|rpcuser|rpcpassword|testnet4|chain)=?/.test(a) && a !== '-testnet4');
let [method, ...params] = args;
if (method === '-named') [method, ...params] = params;
appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ args: process.argv.slice(2), method, params }) + '\n');
const spec = JSON.parse(readFileSync(process.env.FAKE_CLI_SPEC, 'utf8'));
const out = (v) => { process.stdout.write(typeof v === 'string' ? v + '\n' : JSON.stringify(v) + '\n'); process.exit(0); };
if (spec.fail && spec.fail[method]) { process.stderr.write(`error code: -1\nerror message:\n${spec.fail[method]}\n`); process.exit(1); }
const named = Object.fromEntries(params.filter((p) => /^[a-z_]+=/.test(p)).map((p) => [p.slice(0, p.indexOf('=')), JSON.parse(p.slice(p.indexOf('=') + 1))]));
const real = (hex) => { try { return /^[0-9a-f]+$/.test(hex) ? parseTransaction(fromHex(hex)) : null; } catch { return null; } };
const txidOf = (tx) => toHex(Uint8Array.from(tx.txid).reverse());
const le = (n, bytes) => Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
const unsigned = (ins, outs) => toHex(Uint8Array.from([...le(2, 4), ins.length,
  ...ins.flatMap((i) => [...fromHex(i.txid).reverse(), ...le(i.vout, 4), 0, ...le(0xfffffffd, 4)]), outs.length,
  ...outs.flatMap((o) => [...le(o.sats, 8), o.spk.length, ...o.spk]), ...le(0, 4)]));
switch (method) {
  case 'getblockhash': out(`hash${params[0]}`);
  case 'getblockheader': { const h = params[0].replace(/^hash/, ''); if (!(h in spec.mtp)) { process.stderr.write(`no header for ${h}\n`); process.exit(1); } out({ height: Number(h), mediantime: spec.mtp[h] }); }
  case 'getblockchaininfo': out(spec.tip);
  case 'getblockcount': out(String(spec.tip.blocks));
  case 'listunspent': out(spec.utxos);
  case 'createrawtransaction': out(`raw:${params.join('|')}`);
  case 'fundrawtransaction': out({ hex: `funded:${params[0]}`, fee: 0.000003, changepos: 1 });
  case 'signrawtransactionwithwallet': out({ hex: `signed:${params[0]}`, complete: true });
  case 'listwallets': out(spec.wallets || []);
  case 'scantxoutset': out({ success: true, unspents: (spec.scan || {})[JSON.parse(params[1])[0]] || [] });
  case 'getrawtransaction': if ((spec.raw || {})[params[0]]) out(spec.raw[params[0]]); process.stderr.write('No such mempool or blockchain transaction\n'); process.exit(5);
  case 'gettxout': { const o = (spec.txout || {})[`${params[0]}:${params[1]}`]; if (o) out(o); process.exit(0); } // bitcoin-cli prints nothing for a spent output
  case 'getnewaddress': out(`addr:0014${'dd'.repeat(20)}`);
  case 'getaddressinfo': out({ address: params[0], scriptPubKey: params[0].replace(/^addr:/, '') });
  case 'decodescript': out({ address: `addr:${params[0]}` });
  case 'walletcreatefundedpsbt': {
    const ins = named.inputs;
    const outs = named.outputs.map((o) => { const [a, btc] = Object.entries(o)[0]; return { spk: [...fromHex(a.replace(/^addr:/, ''))], sats: Math.round(btc * 1e8) }; });
    const inSats = ins.reduce((s, i) => s + Math.round(((spec.txout || {})[`${i.txid}:${i.vout}`] || { value: 0 }).value * 1e8), 0);
    const fee = 600, change = inSats - fee - outs.reduce((s, o) => s + o.sats, 0);
    out({ psbt: `psbt:${unsigned(ins, [...outs, { spk: [0x00, 0x14, ...new Array(20).fill(0xcc)], sats: change }])}`, fee: fee / 1e8, changepos: outs.length });
  }
  case 'walletprocesspsbt': out({ psbt: params[0], complete: spec.signs !== false });
  case 'finalizepsbt': out({ complete: spec.signs !== false, hex: params[0].replace(/^psbt:/, '') });
  case 'decoderawtransaction': { const tx = real(params[0]); if (tx) out({ txid: txidOf(tx), vsize: params[0].length / 2,
    vin: tx.inputs.map((i) => ({ txid: toHex(Uint8Array.from(i.previousTxid).reverse()), vout: i.previousVout })),
    vout: tx.outputs.map((o, n) => ({ n, value: Number(o.value) / 1e8, scriptPubKey: { hex: toHex(o.script) } })) }); }
    out({ txid: 'f'.repeat(64), vsize: 150, vin: [{ txid: spec.input.txid, vout: spec.input.vout }], vout: [] });
  case 'testmempoolaccept': out(JSON.parse(params[0]).map((hex, i) => { const tx = real(hex); const why = (spec.refuse || {})[i];
    return why ? { txid: tx ? txidOf(tx) : 'f'.repeat(64), allowed: false, 'reject-reason': why }
      : { txid: tx ? txidOf(tx) : 'f'.repeat(64), allowed: spec.mempool ? spec.mempool.allowed : true, 'reject-reason': spec.mempool ? spec.mempool.reason : undefined }; }));
  case 'sendrawtransaction': if (spec.send === true) out(txidOf(real(params[0]))); if (spec.send) out(spec.send); process.stderr.write('sendrawtransaction refused by the fake\n'); process.exit(1);
  default: process.stderr.write(`the fake bitcoin-cli has no answer for ${method}\n`); process.exit(1);
}
