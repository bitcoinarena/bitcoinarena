// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// STOPPED NODES STEP OUT OF THE CENSUS, THEIR BONDS UNTOUCHED (§5A.3; kanban #727, 2026-10-27). A stopped test node whose bond
// is still locked stays in every census and is drawn: on 2026-10-27 every Up/Down v23 round drew 0-2 live nodes of 9 and none was
// seated. Each named store's node writes its newest advertisement again with serving = false (nothing else changes), as
// testnet4-advert-update.mjs does with ARENA_ADVERT_SERVING=false for the seats - here for stores kept anywhere, one funding input
// paying every carrier. Without --publish it builds everything, checks it with testmempoolaccept, and broadcasts nothing.
//
//   STORES=<store.db>,<store.db>,... ARENA_FUND_INPUT=<txid>:<vout> node tools/testnet4-step-out.mjs [--publish]
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { regtest } from './regtest-bond.mjs';
import { inForceOf } from '../src/add-bond-wallet.js';
import { openStore, nodeIdentity } from '../src/store.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { readAdvertUpdate, checkAgainstBond } from '../../arena-protocol/src/advert-update.js';
import { schnorr } from '@noble/curves/secp256k1.js';

const env = process.env;
const publish = process.argv.includes('--publish');
// THE RETURN (kanban #397, the owner 2026-11-03: "t3-1 .. t3-7 get the RETURN update and go back into the live draw"): ARENA_SERVING=true writes
// the newest advertisement again with serving = true - the same update in the other direction, bond untouched
const SERVING = env.ARENA_SERVING === 'true';
const datadir = env.ARENA_TN4_DATADIR || '/mnt/bitcoin/tn4';
const wallet = env.ARENA_TN4_BOND_WALLET || 'blwp-tn4-bonds';
const cli = (...a) => execFileSync(env.BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli',
  [`-datadir=${datadir}`, `-rpcwallet=${wallet}`, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 }).trim();
const say = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v)));
const CARRIER_SATS = 3000n;
const stores = String(env.STORES || '').split(',').filter(Boolean);
const [fundTxid, fundVout] = (env.ARENA_FUND_INPUT || '').split(':');
if (!stores.length) throw new Error('STORES=<store.db>,...: the nodes that step out');
if (!/^[0-9a-f]{64}$/.test(fundTxid || '') || !/^\d+$/.test(fundVout || '')) throw new Error('ARENA_FUND_INPUT=<txid>:<vout>: the one output that pays every carrier');

const rt = regtest(cli, { network: 'testnet4', wallet });
const plans = [];
for (const store of stores) {
  const db = openStore(store);
  const { secret, pubkey } = nodeIdentity(db);
  db.close?.();
  const bonds = rt.bondsOf(secret);
  if (!bonds.length) { say({ store, nodeKey: toHex(pubkey).slice(0, 16), skipped: 'no confirmed unspent bond' }); continue; }
  // THE BODY IN FORCE (kanban #1836): the update still goes on the largest output, but it starts from the node's newest advertisement
  // over all its outputs (inForceOf, as the census reads it), not the largest's own - an update since on another output is kept
  const largest = [...bonds].sort((x, y) => (y.sats - x.sats) || (y.height - x.height))[0];
  const bond = { ...largest, advert: inForceOf(bonds).advert };
  if ((bond.advert.serving !== false) === SERVING) { say({ store, nodeKey: toHex(pubkey).slice(0, 16), skipped: SERVING ? 'already serving' : 'already stepped out' }); continue; }
  const advert = { ...bond.advert, serving: SERVING, timestamp: BigInt(Date.now()) };
  say({ store, nodeKey: toHex(pubkey).slice(0, 16), bond: `${bond.txid}:${bond.vout}`, sats: bond.sats, games: (bond.advert.hostedGames || []).length });
  plans.push({ n: toHex(pubkey).slice(0, 8), secret, bond, advert, prepared: rt.prepareAdvertUpdate(secret, advert) });
}
if (!plans.length) { say({ done: SERVING ? 'nothing to return' : 'nothing to step out' }); process.exit(0); }

const keysPath = `${env.CARRIER_KEYS_DIR || '.'}/step-out-carriers-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}.json`;
writeFileSync(keysPath, JSON.stringify(plans.map((p) => ({ node: p.n, bond: `${p.bond.txid}:${p.bond.vout}`,
  carrierSecret: toHex(p.prepared.carrierSecret), carrierSpk: toHex(p.prepared.spk) })), null, 2) + '\n', { mode: 0o600 });

const input = JSON.parse(cli('gettxout', fundTxid, fundVout, 'true') || 'null');
if (!input) throw new Error(`${fundTxid}:${fundVout} is not an unspent output`);
if (Math.round(input.value * 1e8) === 50000 || Math.round(input.value * 1e8) === 1670) throw new Error('that input has a bond\'s or a marker\'s value; it is not spent here');
const outputs = plans.map((p) => ({ [JSON.parse(cli('decodescript', toHex(p.prepared.spk))).address]: Number(CARRIER_SATS) / 1e8 }));
const funded = JSON.parse(cli('-named', 'walletcreatefundedpsbt', `inputs=${JSON.stringify([{ txid: fundTxid, vout: Number(fundVout) }])}`,
  `outputs=${JSON.stringify(outputs)}`, `options=${JSON.stringify({ add_inputs: false, include_unsafe: true, fee_rate: 2 })}`));
const final = JSON.parse(cli('finalizepsbt', JSON.parse(cli('walletprocesspsbt', funded.psbt)).psbt));
if (!final.complete) throw new Error('the funding transaction did not sign');
const fundingTx = JSON.parse(cli('decoderawtransaction', final.hex));
if (fundingTx.vin.length !== 1 || fundingTx.vin[0].txid !== fundTxid || fundingTx.vin[0].vout !== Number(fundVout))
  throw new Error('the funding transaction spends something other than the named input');
const updates = await Promise.all(plans.map(async (p) => {
  const vout = fundingTx.vout.find((o) => o.scriptPubKey.hex === toHex(p.prepared.spk)).n;
  const u = rt.postAdvertUpdate(p.prepared, { txid: p.bond.txid, vout: p.bond.vout }, { utxo: { txid: fundingTx.txid, vout, value: CARRIER_SATS } });
  const d = JSON.parse(cli('decoderawtransaction', u.hex));
  if (d.vin.length !== 1 || d.vin[0].txid !== fundingTx.txid) throw new Error(`node ${p.n}: the update spends something other than its carrier`);
  if (d.vout.some((o) => Math.round(o.value * 1e8) >= 50000)) throw new Error(`node ${p.n}: the update carries a bond-sized output`);
  const read = readAdvertUpdate(fromHex(u.hex), { network: 'testnet4' });
  const checked = read.ok ? await checkAgainstBond(read, { txid: fromHex(p.bond.txid).reverse(), vout: p.bond.vout,
    nodePubkey: p.advert.nodePubkey }, (sig, msg, key) => schnorr.verify(sig, msg, key)) : read;
  if (!checked.ok) throw new Error(`node ${p.n}: the update does not read back: ${checked.why}`);
  if ((checked.advert.serving !== false) !== SERVING) throw new Error(`node ${p.n}: read back ${SERVING ? 'not serving' : 'still serving'}`);
  return { ...p, ...u };
}));
const accept = JSON.parse(cli('testmempoolaccept', JSON.stringify([final.hex, ...updates.map((u) => u.hex)])));
say({ funding: fundingTx.txid, fundingFee: funded.fee, carriers: plans.length, carrierKeys: keysPath,
  accept: accept.map((a) => ({ txid: a.txid.slice(0, 16), allowed: a.allowed, why: a['reject-reason'] || null })) });
if (!accept.every((a) => a.allowed)) throw new Error('the mempool refuses a transaction above; nothing is broadcast');
if (!publish) { say({ published: false, why: 'no --publish: built and checked, nothing broadcast' }); process.exit(0); }
cli('sendrawtransaction', final.hex);
for (const u of updates) cli('sendrawtransaction', u.hex);
say({ published: true, funding: fundingTx.txid, updates: updates.map((u) => `${u.n} ${u.txid}`) });
