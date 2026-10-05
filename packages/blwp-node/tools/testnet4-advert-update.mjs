// ADVERTISEMENT UPDATES FOR THE SEVEN TESTNET4 BONDS, NOT NEW BONDS (spec §5A.2; the owner 2026-09-28, the
// advertisement-update letter: "Bond 0c82db59 stays the bond. Do not post a new bond. Do not spend the bond. Do not
// start a maturity clock ... one small transaction per node, seven in all, paid from the bond wallet. Each names that
// node's existing bond outpoint and its new advert, the refounded guardian key").
//
// The refound kept federation 337ae01a (its id is its endpoints) and gave every guardian a new key, so each bond's
// advertisement still names the old one (node 1: 034d69fa, now 027acbea) and the federation reads as unbonded. Per
// node this reads the node's key from its store, finds its confirmed unspent bond on chain (the newest, as the runner
// selects it), and writes the bond's advertisement again with guardian_of set to the key the node's own guardian holds
// now (<store>.guardian: local.json's peer id, consensus.json's broadcast key for it) and a new timestamp. Nothing else
// in the advertisement changes.
//
// PAID FROM ONE NAMED INPUT: one funding transaction spends exactly BLWP_FUND_INPUT (txid:vout) of the bond wallet -
// never a bond, never a marker, nothing coin selection picks - into seven carrier outputs; each update spends its
// carrier: marker dust, OP_RETURN "BLW" 'A' bond_outpoint H(advertisement), the signed body in the witness. The carrier
// keys are written (0600) before anything is broadcast, so a funded carrier is never stranded.
//
// Without --publish it builds everything, checks it with testmempoolaccept, and broadcasts nothing.
//
//   BLWP_FUND_INPUT=<txid>:<vout> node tools/testnet4-advert-update.mjs [--publish]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { regtest } from './regtest-bond.mjs';
import { openStore, nodeIdentity } from '../src/store.js';
import { readInvite } from '../src/invite.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';
import { readAdvertUpdate, checkAgainstBond } from '../../protocol/src/advert-update.js';
import { schnorr } from '@noble/curves/secp256k1.js';

const env = process.env;
const publish = process.argv.includes('--publish');
const home = env.BLWP_TESTNET4_DIR || `${env.HOME}/blwp-testnet4`;
const datadir = env.BLWP_TN4_DATADIR || '/mnt/bitcoin/tn4';
const wallet = env.BLWP_TN4_BOND_WALLET || 'blwp-tn4-bonds';
const cli = (...a) => execFileSync(env.BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli',
  [`-datadir=${datadir}`, `-rpcwallet=${wallet}`, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 }).trim();
const say = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v)));
const CARRIER_SATS = 3000n;

const [fundTxid, fundVout] = (env.BLWP_FUND_INPUT || '').split(':');
if (!/^[0-9a-f]{64}$/.test(fundTxid || '') || !/^\d+$/.test(fundVout || ''))
  throw new Error('BLWP_FUND_INPUT=<txid>:<vout>: the one bond-wallet output that pays for the seven updates');

const rt = regtest(cli, { network: 'testnet4', wallet });
const federationId = fromHex(readInvite(readFileSync(join(home, 'invite-code'), 'utf8').replace(/["\s]/g, '')).federationId);

const plans = [];
for (let n = 1; n <= 7; n++) {
  const store = join(home, `node-${n}.db`);
  const db = openStore(store);
  const { secret, pubkey } = nodeIdentity(db);
  db.close?.();
  const dir = `${store}.guardian`;
  const peer = JSON.parse(readFileSync(`${dir}/local.json`, 'utf8')).identity;
  const guardianKey = JSON.parse(readFileSync(`${dir}/consensus.json`, 'utf8')).broadcast_public_keys[String(peer)];
  if (!/^[0-9a-f]{66}$/.test(guardianKey || '')) throw new Error(`${dir}: no broadcast key for its own peer ${peer}`);
  const bonds = rt.bondsOf(secret);
  if (!bonds.length) throw new Error(`node ${n} (${toHex(pubkey).slice(0, 8)}) has no confirmed unspent bond: nothing to update, and no bond is posted`);
  const bond = bonds[0];
  const now = (bond.advert.guardianOf || []).map((x) => `${toHex(x.federationId)}:${toHex(x.guardianKey)}`);
  const want = `${toHex(federationId)}:${guardianKey}`;
  say({ node: n, nodeKey: toHex(pubkey).slice(0, 16), bond: `${bond.txid}:${bond.vout}`, bondHeight: bond.height, sats: bond.sats,
    otherBonds: bonds.slice(1).map((b) => `${b.txid}:${b.vout}`), advertises: now, updatedBy: bond.updatedBy || null, wants: want });
  if (now.length === 1 && now[0] === want) { say({ node: n, update: 'not needed: its advertisement already names that key' }); continue; }
  const advert = { ...bond.advert, guardianOf: [{ federationId, guardianKey: fromHex(guardianKey) }], timestamp: BigInt(Date.now()) };
  plans.push({ n, secret, bond, advert, prepared: rt.prepareAdvertUpdate(secret, advert) });
}
if (!plans.length) { say({ done: 'every bond already advertises its node\'s current guardian key; nothing posted' }); process.exit(0); }

// THE CARRIER KEYS, WRITTEN FIRST
const keysPath = join(home, `advert-update-carriers-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}.json`);
writeFileSync(keysPath, JSON.stringify(plans.map((p) => ({ node: p.n, bond: `${p.bond.txid}:${p.bond.vout}`,
  carrierSecret: toHex(p.prepared.carrierSecret), carrierSpk: toHex(p.prepared.spk) })), null, 2) + '\n', { mode: 0o600 });

// ONE FUNDING TRANSACTION FROM THE NAMED INPUT ONLY
// bitcoin-cli prints nothing at all for a spent or unknown output
const input = JSON.parse(cli('gettxout', fundTxid, fundVout, 'true') || 'null');
if (!input) throw new Error(`${fundTxid}:${fundVout} is not an unspent output`);
if (Math.round(input.value * 1e8) === 50000 || Math.round(input.value * 1e8) === 1670) throw new Error('that input has a bond\'s or a marker\'s value; it is not spent here');
const outputs = plans.map((p) => ({ [JSON.parse(cli('decodescript', toHex(p.prepared.spk))).address]: Number(CARRIER_SATS) / 1e8 }));
const funded = JSON.parse(cli('-named', 'walletcreatefundedpsbt', `inputs=${JSON.stringify([{ txid: fundTxid, vout: Number(fundVout) }])}`,
  `outputs=${JSON.stringify(outputs)}`, `options=${JSON.stringify({ add_inputs: false, include_unsafe: true, fee_rate: 2 })}`));
const signed = JSON.parse(cli('walletprocesspsbt', funded.psbt));
const final = JSON.parse(cli('finalizepsbt', signed.psbt));
if (!final.complete) throw new Error('the funding transaction did not sign');
const fundingHex = final.hex;
const fundingTx = JSON.parse(cli('decoderawtransaction', fundingHex));
if (fundingTx.vin.length !== 1 || fundingTx.vin[0].txid !== fundTxid || fundingTx.vin[0].vout !== Number(fundVout))
  throw new Error('the funding transaction spends something other than the named input');
const updates = await Promise.all(plans.map(async (p) => {
  const vout = fundingTx.vout.find((o) => o.scriptPubKey.hex === toHex(p.prepared.spk)).n;
  const u = rt.postAdvertUpdate(p.prepared, { txid: p.bond.txid, vout: p.bond.vout },
    { utxo: { txid: fundingTx.txid, vout, value: CARRIER_SATS } });
  const d = JSON.parse(cli('decoderawtransaction', u.hex));
  // NO BOND IS SPENT OR POSTED: the update's one input is its carrier, and no output pays a bond's 50 000 sats
  if (d.vin.length !== 1 || d.vin[0].txid !== fundingTx.txid) throw new Error(`node ${p.n}: the update spends something other than its carrier`);
  if (d.vout.some((o) => Math.round(o.value * 1e8) >= 50000)) throw new Error(`node ${p.n}: the update carries a bond-sized output`);
  // AND THE READERS READ IT AS AN UPDATE OF THAT BOND, SIGNED BY ITS NODE, before anything is broadcast
  const read = readAdvertUpdate(fromHex(u.hex), { network: 'testnet4' });
  const checked = read.ok ? await checkAgainstBond(read, { txid: fromHex(p.bond.txid).reverse(), vout: p.bond.vout,
    nodePubkey: p.advert.nodePubkey }, (sig, msg, key) => schnorr.verify(sig, msg, key)) : read;
  if (!checked.ok) throw new Error(`node ${p.n}: the update does not read back: ${checked.why}`);
  if (toHex(checked.advert.guardianOf[0].guardianKey) !== toHex(p.advert.guardianOf[0].guardianKey)) throw new Error(`node ${p.n}: read back another key`);
  return { ...p, ...u, vsize: d.vsize };
}));
const accept = JSON.parse(cli('testmempoolaccept', JSON.stringify([fundingHex, ...updates.map((u) => u.hex)])));
say({ funding: fundingTx.txid, fundingFee: funded.fee, carriers: plans.length, carrierKeys: keysPath,
  accept: accept.map((a) => ({ txid: a.txid.slice(0, 16), allowed: a.allowed, why: a['reject-reason'] || null })) });
if (!accept.every((a) => a.allowed)) throw new Error('the mempool refuses a transaction above; nothing is broadcast');
for (const u of updates)
  say({ node: u.n, update: u.txid, advertId: u.advertId, bond: `${u.bond.txid}:${u.bond.vout}`, vsize: u.vsize,
    guardianKey: toHex(u.advert.guardianOf[0].guardianKey) });
if (!publish) { say({ published: false, why: 'no --publish: built and checked, nothing broadcast' }); process.exit(0); }
cli('sendrawtransaction', fundingHex);
for (const u of updates) cli('sendrawtransaction', u.hex);
say({ published: true, funding: fundingTx.txid, updates: updates.map((u) => u.txid) });
