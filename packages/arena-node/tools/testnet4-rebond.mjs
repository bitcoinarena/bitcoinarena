// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEVEN TESTNET4 BONDS MOVED INTO TEMPLATE 2 (2026-10-11: "the 7 testnet4 bonds re-bonded to v2
// at confirmation + 144, path A refused before H, census counts all 7"; "spend path A into a v2 bond and publish the new
// advert, only after a testmempoolaccept dry run").
//
// Template 1 put genesis' 100 in every recovery leaf, so path A of all seven was spendable from the block each confirmed
// in (spec 5A.3B wants ~1 day on testnet4). Per node this reads the node's key from its store, finds its confirmed
// unspent bond (bondsOf: the newest, with the advertisement it stands for now - the newest signed update), and builds one
// transaction: the old bond spent by path A (its own key, its maturity long past) and a carrier whose witness holds the
// new signed body, into a template-2 bond of THE SAME VALUE whose leaf carries tip + 1 + slack + 144, the marker dust and
// the commitment. Nothing in the advertisement changes but the template, its height and the timestamp.
//
// PAID FROM ONE NAMED INPUT, as the advertisement updates were: one funding transaction spends exactly ARENA_FUND_INPUT
// (txid:vout) of the bond wallet into seven carriers; the carrier keys are written (0600) before anything is broadcast.
//
// Without --publish it builds everything, checks it with testmempoolaccept, and broadcasts nothing. With --measure it
// builds nothing and asks bitcoind about path A of each node's template-2 bond at H - 1 and at H, and reads the census
// rule against the block each confirmed in.
//
//   ARENA_FUND_INPUT=<txid>:<vout> node tools/testnet4-rebond.mjs [--publish]
//   node tools/testnet4-rebond.mjs --measure
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { regtest } from './regtest-bond.mjs';
import { openStore, nodeIdentity } from '../src/store.js';
import { bondSetFor } from '../src/curve.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { advertInTransaction } from '../../arena-protocol/src/census.js';
import { recognizeBond } from '../../arena-protocol/src/chain.js';
import { maturityStands, recoveryLeaf, tapLeafHash, controlBlockFor, BOND_TEMPLATE_V2 } from '../../arena-protocol/src/bond-script.js';
import { tapSighash, scriptPathWitness, serializeSpend } from '../../arena-protocol/src/bond-spend.js';

const env = process.env;
const publish = process.argv.includes('--publish');
const measure = process.argv.includes('--measure');
const home = env.ARENA_TESTNET4_DIR || `${env.HOME}/blwp-testnet4`;
const datadir = env.ARENA_TN4_DATADIR || '/mnt/bitcoin/tn4';
const wallet = env.ARENA_TN4_BOND_WALLET || 'blwp-tn4-bonds';
const NODES = (env.ARENA_REBOND_NODES || '1,2,3,4,5,6,7').split(',').map(Number);
const SLACK = Number(env.ARENA_REBOND_SLACK || 12);    // blocks the re-bond may wait for a miner (~10 min each on testnet4)
const cli = (...a) => execFileSync(env.BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli',
  [`-datadir=${datadir}`, `-rpcwallet=${wallet}`, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 }).trim();
const say = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v)));
const CARRIER_SATS = 3000n;
const FEE_SATS = 1500n;

const rt = regtest(cli, { network: 'testnet4', wallet });
const nodes = NODES.map((n) => {
  const db = openStore(join(home, `node-${n}.db`));
  const { secret, pubkey } = nodeIdentity(db);
  db.close?.();
  return { n, secret, pubkey, bonds: rt.bondsOf(secret) };
});

if (measure) {
  // PATH A OF EACH TEMPLATE-2 BOND, ASKED OF BITCOIND NOW: a spend at locktime H - 1 and one at H, each signed by the
  // node's own key to its own wallet address. Below H both are refused - "non-final" while the tip is under the locktime,
  // "Locktime requirement not satisfied" once the tip has reached H - 1 - and at tip H the second one is accepted.
  const tip = rt.height();
  for (const x of nodes) {
    const b = x.bonds.find((y) => y.advert.bondScriptTemplateVersion === BOND_TEMPLATE_V2);
    if (!b) { say({ node: x.n, template2: null, bonds: x.bonds.map((y) => `${y.txid}:${y.vout} t${y.advert.bondScriptTemplateVersion}`) }); continue; }
    const built = rt.keyAt(x.pubkey, b.maturity);
    const spk = fromHex('5120' + toHex(built.outputKey));
    const leaf = recoveryLeaf(x.pubkey, b.maturity);
    const payTo = rt.payTo();
    const ask = (locktime) => {
      const tx = { version: 2, locktime, inputs: [{ txid: fromHex(b.txid).reverse(), vout: b.vout, sequence: 0xfffffffe }],
        outputs: [{ value: BigInt(b.sats) - 1000n, script: payTo }] };
      const sig = schnorr.sign(tapSighash({ ...tx, prevouts: [{ value: BigInt(b.sats), script: spk }], inputIndex: 0, leafHash: tapLeafHash(leaf) }), x.secret);
      const hex = toHex(serializeSpend({ ...tx, witnesses: [scriptPathWitness({ stack: [sig], script: leaf, controlBlock: controlBlockFor('recovery', built).controlBlock })] }));
      const r = JSON.parse(cli('testmempoolaccept', JSON.stringify([hex])))[0];
      return { allowed: r.allowed, why: r['reject-reason'] || null };
    };
    say({ node: x.n, bond: `${b.txid}:${b.vout}`, sats: b.sats, confirmed: b.height, maturity: b.maturity, tip,
      census: maturityStands(b.advert, b.height, 'testnet4'), pathA: { atHminus1: ask(b.maturity - 1), atH: ask(b.maturity) },
      blocksToMaturity: b.maturity - tip });
  }
  process.exit(0);
}

const [fundTxid, fundVout] = (env.ARENA_FUND_INPUT || '').split(':');
if (!/^[0-9a-f]{64}$/.test(fundTxid || '') || !/^\d+$/.test(fundVout || ''))
  throw new Error('ARENA_FUND_INPUT=<txid>:<vout>: the one bond-wallet output that pays for the seven carriers');

const plans = [];
for (const x of nodes) {
  if (!x.bonds.length) throw new Error(`node ${x.n} (${toHex(x.pubkey).slice(0, 8)}) has no confirmed unspent bond: nothing to move, and none is posted`);
  const bond = x.bonds[0];
  say({ node: x.n, nodeKey: toHex(x.pubkey).slice(0, 16), bond: `${bond.txid}:${bond.vout}`, bondHeight: bond.height, sats: bond.sats,
    template: bond.advert.bondScriptTemplateVersion, maturity: bond.maturity, ancestor: !!bond.ancestor, updatedBy: bond.updatedBy || null,
    otherBonds: x.bonds.slice(1).map((b) => `${b.txid}:${b.vout}`) });
  // A TEMPLATE-2 BOND THE CENSUS NEVER COUNTS is moved too (measured 2026-10-19: T2's four guardians' bonds confirmed at
  // 156669 with maturity 156807, "6 block(s) short of its confirmation 156669 plus 144" - so T2 was never named and had no record)
  const stands = maturityStands(bond.advert, bond.height, 'testnet4');
  if (bond.advert.bondScriptTemplateVersion === BOND_TEMPLATE_V2 && stands.ok) { say({ node: x.n, rebond: 'not needed: its bond is template 2 and counts' }); continue; }
  if (!stands.ok) say({ node: x.n, rebond: `its bond never counts: ${stands.why}` });
  const advert = { ...bond.advert, timestamp: BigInt(Date.now()) };
  plans.push({ n: x.n, secret: x.secret, bond, prepared: rt.prepareRebond(x.secret, bond, advert, { slackBlocks: SLACK }) });
}
if (!plans.length) { say({ done: 'every bond is template 2 and counts already; nothing posted' }); process.exit(0); }

// THE CARRIER KEYS, WRITTEN FIRST
const keysPath = join(home, `rebond-carriers-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}.json`);
writeFileSync(keysPath, JSON.stringify(plans.map((p) => ({ node: p.n, bond: `${p.bond.txid}:${p.bond.vout}`, maturity: p.prepared.maturity,
  carrierSecret: toHex(p.prepared.carrierSecret), carrierSpk: toHex(p.prepared.spk) })), null, 2) + '\n', { mode: 0o600 });

// ONE FUNDING TRANSACTION FROM THE NAMED INPUT ONLY
const input = JSON.parse(cli('gettxout', fundTxid, fundVout, 'true') || 'null');
if (!input) throw new Error(`${fundTxid}:${fundVout} is not an unspent output`);
if (Math.round(input.value * 1e8) === 50000 || Math.round(input.value * 1e8) === 1670) throw new Error('that input has a bond\'s or a marker\'s value; it is not spent here');
const outputs = plans.map((p) => ({ [JSON.parse(cli('decodescript', toHex(p.prepared.spk))).address]: Number(CARRIER_SATS) / 1e8 }));
const funded = JSON.parse(cli('-named', 'walletcreatefundedpsbt', `inputs=${JSON.stringify([{ txid: fundTxid, vout: Number(fundVout) }])}`,
  `outputs=${JSON.stringify(outputs)}`, `options=${JSON.stringify({ add_inputs: false, include_unsafe: true, fee_rate: 2 })}`));
const final = JSON.parse(cli('finalizepsbt', JSON.parse(cli('walletprocesspsbt', funded.psbt)).psbt));
if (!final.complete) throw new Error('the funding transaction did not sign');
const fundingHex = final.hex;
const fundingTx = JSON.parse(cli('decoderawtransaction', fundingHex));
if (fundingTx.vin.length !== 1 || fundingTx.vin[0].txid !== fundTxid || fundingTx.vin[0].vout !== Number(fundVout))
  throw new Error('the funding transaction spends something other than the named input');

const bond = bondSetFor('testnet4');
const tip = rt.height();
const moves = plans.map((p) => {
  const vout = fundingTx.vout.find((o) => o.scriptPubKey.hex === toHex(p.prepared.spk)).n;
  const m = rt.postRebond(p.prepared, { utxo: { txid: fundingTx.txid, vout, value: CARRIER_SATS }, feeSats: FEE_SATS });
  const d = JSON.parse(cli('decoderawtransaction', m.hex));
  // THE OLD BOND AND THE CARRIER, NOTHING ELSE; THE NEW BOND KEEPS EVERY SAT
  if (d.vin.length !== 2 || d.vin[0].txid !== p.bond.txid || d.vin[0].vout !== p.bond.vout || d.vin[1].txid !== fundingTx.txid)
    throw new Error(`node ${p.n}: the re-bond spends something other than its bond and its carrier`);
  if (Math.round(d.vout[0].value * 1e8) !== p.bond.sats) throw new Error(`node ${p.n}: the new bond is not the old bond's ${p.bond.sats} sats`);
  // AND THE READERS READ IT AS A TEMPLATE-2 BOND OF THIS NODE, its key rebuilt from the body, before anything is broadcast
  const tx = parseTransaction(fromHex(m.hex));
  const advert = advertInTransaction(tx);
  if (!advert || advert.bondScriptTemplateVersion !== BOND_TEMPLATE_V2 || advert.bondMaturityHeight !== m.maturity
    || toHex(advert.nodePubkey) !== toHex(p.prepared.nodeKey)) throw new Error(`node ${p.n}: the body does not read back as its template-2 advertisement`);
  const seen = recognizeBond(tx, 0, advert, { network: 'testnet4', bond });
  if (!seen.ok) throw new Error(`node ${p.n}: the new bond is not recognised: ${seen.why}`);
  const ifNext = maturityStands(advert, tip + 1, 'testnet4');
  const ifLast = maturityStands(advert, tip + 1 + SLACK, 'testnet4');
  if (!ifNext.ok || !ifLast.ok) throw new Error(`node ${p.n}: ${ifLast.why || ifNext.why}`);
  return { ...p, ...m, vsize: d.vsize, advert };
});
const accept = JSON.parse(cli('testmempoolaccept', JSON.stringify([fundingHex, ...moves.map((m) => m.hex)])));
say({ funding: fundingTx.txid, fundingFee: funded.fee, carriers: plans.length, carrierKeys: keysPath, tip,
  accept: accept.map((a) => ({ txid: a.txid.slice(0, 16), allowed: a.allowed, why: a['reject-reason'] || null })) });
if (!accept.every((a) => a.allowed)) throw new Error('the mempool refuses a transaction above; nothing is broadcast');
for (const m of moves)
  say({ node: m.n, rebond: m.txid, advertId: m.advertId, from: `${m.bond.txid}:${m.bond.vout}`, sats: String(m.bondSats), maturity: m.maturity,
    countsIfConfirmedBy: m.maturity - 144, vsize: m.vsize, hosts: m.advert.hostedGames.length, guardianOf: m.advert.guardianOf.length });
if (!publish) { say({ published: false, why: 'no --publish: built and checked, nothing broadcast' }); process.exit(0); }
cli('sendrawtransaction', fundingHex);
for (const m of moves) cli('sendrawtransaction', m.hex);
say({ published: true, funding: fundingTx.txid, rebonds: moves.map((m) => m.txid) });
