#!/usr/bin/env node
/**
 * THE COOPERATIVE RELEASE, ACCEPTED BY BITCOIND (kanban #307, spec §5A.3B key path: MuSig2(node_key, arbitration aggregate)):
 * on a regtest chain a bond output is funded at the key bond-script.js builds for a node and the regtest arbitration set; a
 * spend of it back to the wallet is signed on its KEY PATH - the seat's half over its owner doors (POST /owner/musig/*,
 * signed by the owner), the 7 members' over the arbiter's doors (POST /musig/*) - aggregated to one BIP-340 signature,
 * handed to testmempoolaccept, sent and mined. The nesting (node key with the members' own aggregate) is not standard
 * BIP-327; this is the measurement of bitcoind taking it.
 *
 *   BITCOIN_CLI="<bitcoin-cli> -datadir=<dir> -rpcwallet=<w>" node tools/musig-release-regtest.mjs
 */
import { execFileSync } from 'node:child_process';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { ownerSecretFromSeed, signOwnerRequest } from '../src/owner.js';
import { arbitrationMembers, serveArbiter } from '../src/arbiter.js';
import { bondSigningContext, bondNonceAgg, bondSignatureAgg } from '../src/musig2.js';
import { bondOutputKey, bondInternalKey, bondTapTree } from '../../arena-protocol/src/bond-script.js';
import { tapSighash, serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { tweakPoint, combine } from '../src/curve.js';

const env = process.env;
if (!env.BITCOIN_CLI) { console.error('BITCOIN_CLI is needed'); process.exit(2); }
const [cli, ...cliArgs] = env.BITCOIN_CLI.split(' ').filter(Boolean);
const bc = (...a) => execFileSync(cli, [...cliArgs, ...a.map(String)], { encoding: 'utf8' }).trim();
const bcj = (...a) => JSON.parse(bc(...a));
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
let code = 0;
const set = arbitrationMembers('regtest');
const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
const seat = await serve(openStore(), { plugins: [], port: 0, chain: 'bitcoin-regtest', owner: { store: { read: () => rec, write: () => {}, writeCode: () => {} } } });
const arb = await serveArbiter({ set, allow: () => ({ ok: true }) });
try {
  const S = `http://127.0.0.1:${seat.port}`, A = `http://127.0.0.1:${arb.port}`;
  const node = (await (await fetch(`${S}/owner`)).json()).node;
  const nodeKey = fromHex(node);
  const signed = (args) => signOwnerRequest({ node, action: 'musig', args, secret, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
  // THE BOND, funded at its output key
  const internalKey = bondInternalKey({ nodeKey, arbitrationKeys: set.keys }, { combine }).internalKey;
  const inputs = { nodeKey, arbitrationKeys: set.keys, arbitrationK: set.k, bondMaturity: Number(bc('getblockcount')) + 107, internalKey };
  const built = bondOutputKey(inputs, { tweakPoint, combine });
  const tweak = bondTapTree(inputs, { combine }).tweak;
  const address = bcj('deriveaddresses', bcj('getdescriptorinfo', `rawtr(${toHex(built.outputKey)})`).descriptor)[0];
  const sats = 200000n;
  const fund = bc('sendtoaddress', address, (Number(sats) / 1e8).toFixed(8));
  bc('generatetoaddress', 1, bc('getnewaddress'));
  const vout = bcj('getrawtransaction', fund, 1).vout.find((o) => o.scriptPubKey.hex === toHex(Uint8Array.from([0x51, 0x20, ...built.outputKey]))).n;
  // THE RELEASE: the whole bond back to the wallet, less 500 sat
  const back = bc('getnewaddress');
  const tx = { version: 2, locktime: 0, inputs: [{ txid: fromHex(fund).reverse(), vout, sequence: 0xfffffffd }],
    outputs: [{ value: sats - 500n, script: fromHex(bcj('getaddressinfo', back).scriptPubKey) }] };
  const msg = tapSighash({ ...tx, prevouts: [{ value: sats, script: Uint8Array.from([0x51, 0x20, ...built.outputKey]) }], inputIndex: 0 });
  const t0 = Date.now();
  const session = { sessionId: 'release-1', tweak: toHex(tweak), msg: toHex(msg) };
  const n1 = await post(`${S}/owner/musig/nonce`, signed(session));
  const a1 = await post(`${A}/musig/nonce`, { sessionId: 'release-1', nodeKey: node, tweak: toHex(tweak), msg: toHex(msg) });
  if (!n1.ok || !a1.ok) throw new Error(`nonces: ${n1.why || a1.why}`);
  const aggnonce = bondNonceAgg({ node: fromHex(n1.pubnonce), members: a1.pubnonces.map((p) => fromHex(p.pubnonce)) });
  const p1 = await post(`${S}/owner/musig/partial`, signed({ sessionId: 'release-1', aggnonce: toHex(aggnonce) }));
  const a2 = await post(`${A}/musig/partial`, { sessionId: 'release-1', aggnonce: toHex(aggnonce) });
  if (!p1.ok || !a2.ok) throw new Error(`partials: ${p1.why || a2.why}`);
  const sig = bondSignatureAgg(bondSigningContext({ nodeKey, arbitrationKeys: set.keys, tweak }), { psigs: [fromHex(p1.psig), ...a2.psigs.map((p) => fromHex(p.psig))], aggnonce, msg });
  const hex = toHex(serializeSpend({ ...tx, witnesses: [[sig]] }));
  const accept = bcj('testmempoolaccept', JSON.stringify([hex]))[0];
  log({ step: 'signed', fund, vout, sats, outputKey: toHex(built.outputKey), signMs: Date.now() - t0, memberPartials: a2.psigs.length, verifies: schnorr.verify(sig, msg, built.outputKey), testmempoolaccept: accept });
  if (!accept.allowed) throw new Error(`testmempoolaccept refused it: ${accept['reject-reason']}`);
  const txid = bc('sendrawtransaction', hex);
  bc('generatetoaddress', 1, bc('getnewaddress'));
  const conf = bcj('getrawtransaction', txid, 1);
  log({ step: 'released', txid, confirmations: conf.confirmations, witnessItems: conf.vin[0].txinwitness.length, vsize: conf.vsize, paidBackSats: sats - 500n });
} catch (e) { code = 1; log({ step: 'stopped', why: String(e.stack || e.message).slice(0, 500) }); }
await seat.close(); await arb.close();
process.exit(code);
