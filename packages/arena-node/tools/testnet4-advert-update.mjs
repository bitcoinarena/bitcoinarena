// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ADVERTISEMENT UPDATES FOR THE SEVEN TESTNET4 BONDS, NOT NEW BONDS (spec §5A.2; 2026-09-28, the
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
// PAID FROM ONE NAMED INPUT: one funding transaction spends exactly ARENA_FUND_INPUT (txid:vout) of the bond wallet -
// never a bond, never a marker, nothing coin selection picks - into seven carrier outputs; each update spends its
// carrier: marker dust, OP_RETURN "ARN" 'A' bond_outpoint H(advertisement), the signed body in the witness. The carrier
// keys are written (0600) before anything is broadcast, so a funded carrier is never stranded.
//
// Without --publish it builds everything, checks it with testmempoolaccept, and broadcasts nothing.
//
//   ARENA_FUND_INPUT=<txid>:<vout> node tools/testnet4-advert-update.mjs [--publish]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { regtest } from './regtest-bond.mjs';
import { inForceOf } from '../src/add-bond-wallet.js';
import { openStore, nodeIdentity } from '../src/store.js';
import { readInvite } from '../src/invite.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { readAdvertUpdate, checkAgainstBond } from '../../arena-protocol/src/advert-update.js';
import { schnorr } from '@noble/curves/secp256k1.js';

const env = process.env;
const publish = process.argv.includes('--publish');
const home = env.ARENA_TESTNET4_DIR || `${env.HOME}/blwp-testnet4`;
const datadir = env.ARENA_TN4_DATADIR || '/mnt/bitcoin/tn4';
const wallet = env.ARENA_TN4_BOND_WALLET || 'blwp-tn4-bonds';
const cli = (...a) => execFileSync(env.BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli',
  [`-datadir=${datadir}`, `-rpcwallet=${wallet}`, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 }).trim();
const say = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v)));
const CARRIER_SATS = 3000n;
// 2026.0.2: ARENA_ADVERT_PROTOCOL_VERSIONS="1,2" - the versions the node speaks, which the census reads to
// draw it for a v2 round - and ARENA_ADVERT_ADD_APPS="<id hex>,..." - games it hosts besides those it advertises (the v2
// ids); each update carries both, everything else of the advertisement as it was
const VERSIONS = env.ARENA_ADVERT_PROTOCOL_VERSIONS ? env.ARENA_ADVERT_PROTOCOL_VERSIONS.split(',').map(Number) : null;
const ADD_APPS = (env.ARENA_ADVERT_ADD_APPS || '').split(',').filter((x) => /^[0-9a-f]{64}$/.test(x));
// STEPPING OUT WITHOUT UNBONDING (§5A.3): ARENA_ADVERT_SERVING=false takes the named nodes out of every census from
// the update's block on (true brings them back), their bonds untouched; ARENA_ADVERT_NODES="3,5" names which (all seven when unset)
const SERVING = env.ARENA_ADVERT_SERVING === 'false' ? false : env.ARENA_ADVERT_SERVING === 'true' ? true : null;
const ONLY = (env.ARENA_ADVERT_NODES || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 1);
// THE SUCCESSOR TOO (§23A.2 "every guardian re-advertises with guardian_of[] naming (federation_id, peer key)"):
// ARENA_ADVERT_GUARDIAN_NEXT=1 - a node seated first in its federation's successor runs a second guardian (<store>.guardian-next);
// once its ceremony is done, guardian_of names both: the federation it still guards through the drain and its successor. Each
// guardian's federation is read from its own directory's invite-code (a node drawn into a successor guards the successor, not
// the federation this machine's invite names); ARENA_ADVERT_NODES may name node numbers past 7 (node 15)
// ON BY DEFAULT (measured 2026-10-19 ~22:45Z): the 10-15 updates named B's successor 4dc88be7, and every later update (the protocol rolls,
// run without the flag) rebuilt guardian_of without it - the census lost the successor's guardians and its record could not be built.
// A finished guardian-next is named unless ARENA_ADVERT_GUARDIAN_NEXT=0.
const GUARDIAN_NEXT = env.ARENA_ADVERT_GUARDIAN_NEXT !== '0';
// THE NODE'S DECLARED SCALARS (§27A.2): ARENA_ADVERT_DECLARE="<bond_min sats>:<proposal deposit sats>"
const DECLARE = /^\d+:\d+$/.test(env.ARENA_ADVERT_DECLARE || '')
  ? (([b, p]) => ({ bondMinSats: BigInt(b), proposalDepositSats: BigInt(p) }))(env.ARENA_ADVERT_DECLARE.split(':')) : null;
// THE OPERATOR IT DECLARES AS A KEY (§5A.13): ARENA_ADVERT_OPERATOR=<64 hex> - an entry declaring the same operator
// conflicts this node in that round (it neither signs nor earns); unset, the advert's operator stays as it was
const OPERATOR = /^[0-9a-f]{64}$/.test(env.ARENA_ADVERT_OPERATOR || '') ? env.ARENA_ADVERT_OPERATOR : null;
// THE GUARDIAN'S PAYOUT KEY (§22A v4.6.4, 2026.0.13, gap 2): ARENA_ADVERT_PAYOUT=1 - each named node's advertisement
// names a real payout_pubkey instead of the placeholder 32 x 0x03 every testnet4 advert carried (measured 2026-10-17): a key made
// once per node and kept (0600, never printed) at ARENA_PAYOUT_KEY_DIR/node-<n>.hex, a copy at ARENA_PAYOUT_KEY_BACKUP when set.
// Only a 2026.0.13 round reads it (its guardian share); below that nothing does.
const PAYOUT = env.ARENA_ADVERT_PAYOUT === '1';
const PAYOUT_DIR = env.ARENA_PAYOUT_KEY_DIR || `${env.HOME}/.config/blwp/seat-payout`;
function payoutKeyOf(n) {
  const file = join(PAYOUT_DIR, `node-${n}.hex`);
  if (!existsSync(file)) {
    mkdirSync(PAYOUT_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(file, toHex(schnorr.utils.randomSecretKey()) + '\n', { mode: 0o600, flag: 'wx' });
    if (env.ARENA_PAYOUT_KEY_BACKUP) { mkdirSync(env.ARENA_PAYOUT_KEY_BACKUP, { recursive: true, mode: 0o700 }); copyFileSync(file, join(env.ARENA_PAYOUT_KEY_BACKUP, `node-${n}.hex`)); chmodSync(join(env.ARENA_PAYOUT_KEY_BACKUP, `node-${n}.hex`), 0o600); }
  }
  return schnorr.getPublicKey(fromHex(readFileSync(file, 'utf8').trim()));
}
const appsWith = (hosted) => [...new Map([...(hosted || []), ...ADD_APPS.map(fromHex)].map((g) => [toHex(g), g])).values()]
  .sort((x, y) => (toHex(x) < toHex(y) ? -1 : 1));

const [fundTxid, fundVout] = (env.ARENA_FUND_INPUT || '').split(':');
if (!/^[0-9a-f]{64}$/.test(fundTxid || '') || !/^\d+$/.test(fundVout || ''))
  throw new Error('ARENA_FUND_INPUT=<txid>:<vout>: the one bond-wallet output that pays for the seven updates');

const rt = regtest(cli, { network: 'testnet4', wallet });
const federationId = fromHex(readInvite(readFileSync(join(home, 'invite-code'), 'utf8').replace(/["\s]/g, '')).federationId);
/** One guardian directory's entry: its own peer's broadcast key, and its federation (its own invite-code, else this machine's). */
function guardianEntry(dir) {
  const peer = JSON.parse(readFileSync(`${dir}/local.json`, 'utf8')).identity;
  const guardianKey = JSON.parse(readFileSync(`${dir}/consensus.json`, 'utf8')).broadcast_public_keys[String(peer)];
  if (!/^[0-9a-f]{66}$/.test(guardianKey || '')) throw new Error(`${dir}: no broadcast key for its own peer ${peer}`);
  let fid = federationId;
  try { fid = fromHex(readInvite(readFileSync(`${dir}/invite-code`, 'utf8').replace(/["\s]/g, '')).federationId); } catch { /* this machine's */ }
  return { federationId: fid, guardianKey: fromHex(guardianKey) };
}

const plans = [];
for (const n of (ONLY.length ? ONLY : [1, 2, 3, 4, 5, 6, 7])) {
  // ARENA_ADVERT_STORE="<path with {n}>" - the stores of nodes kept elsewhere (the seven new macOS nodes, fed2/n495-{n}.db)
  const store = env.ARENA_ADVERT_STORE ? env.ARENA_ADVERT_STORE.split('{n}').join(String(n)) : join(home, `node-${n}.db`);
  const db = openStore(store);
  const { secret, pubkey } = nodeIdentity(db);
  db.close?.();
  const entries = [guardianEntry(`${store}.guardian`)];
  if (GUARDIAN_NEXT && existsSync(`${store}.guardian-next/consensus.json`)) entries.push(guardianEntry(`${store}.guardian-next`));
  // in the order the advertisement encodes them (advert.js: a sorted vec - by federation id, then key)
  entries.sort((x, y) => { const a = toHex(x.federationId) + toHex(x.guardianKey), b = toHex(y.federationId) + toHex(y.guardianKey); return a < b ? -1 : a > b ? 1 : 0; });
  const bonds = rt.bondsOf(secret);
  if (!bonds.length) throw new Error(`node ${n} (${toHex(pubkey).slice(0, 8)}) has no confirmed unspent bond: nothing to update, and no bond is posted`);
  // THE NODE'S MAIN BOND, not its newest output (kanban #544): with an output added beside it (add-bond), the newest by height is
  // the small added one - below protocol 19 the census reads each output's own advertisement and counts only an output above the
  // floor, so the update goes to the largest - the newest on a tie, as before (seat 1 still holds its template-1 genesis output of
  // the same 50,000 sat, which no census counts); from 19 the node's newest advertisement decides for all of them
  // THE BODY IN FORCE (kanban #1836): the update still goes on the largest output, but it starts from the node's newest advertisement
  // over all its outputs (inForceOf, as the census reads it), not the largest's own - an update since on another output is kept
  const largest = [...bonds].sort((x, y) => (y.sats - x.sats) || (y.height - x.height))[0];
  const bond = { ...largest, advert: inForceOf(bonds).advert };
  const now = (bond.advert.guardianOf || []).map((x) => `${toHex(x.federationId)}:${toHex(x.guardianKey)}`);
  const want = entries.map((x) => `${toHex(x.federationId)}:${toHex(x.guardianKey)}`).join(',');
  say({ node: n, nodeKey: toHex(pubkey).slice(0, 16), bond: `${bond.txid}:${bond.vout}`, bondHeight: bond.height, sats: bond.sats,
    otherBonds: bonds.slice(1).map((b) => `${b.txid}:${b.vout}`), advertises: now, protocolVersions: bond.advert.protocolVersions || [], updatedBy: bond.updatedBy || null, wants: want });
  const versionsDiffer = VERSIONS && (bond.advert.protocolVersions || []).join(',') !== VERSIONS.join(',');
  const appsDiffer = ADD_APPS.length && appsWith(bond.advert.hostedGames).length !== (bond.advert.hostedGames || []).length;
  const servingDiffers = SERVING !== null && (bond.advert.serving !== false) !== SERVING;
  const operatorDiffers = OPERATOR !== null && bond.advert.operatorId !== OPERATOR;
  const payout = PAYOUT ? payoutKeyOf(n) : null;
  const payoutDiffers = payout !== null && toHex(bond.advert.payoutPubkey) !== toHex(payout);
  const declaresDiffer = DECLARE && JSON.stringify(bond.advert.declares || null, (k, v) => (typeof v === 'bigint' ? String(v) : v))
    !== JSON.stringify(DECLARE, (k, v) => (typeof v === 'bigint' ? String(v) : v));
  if (now.join(',') === want && !versionsDiffer && !appsDiffer && !servingDiffers && !declaresDiffer && !operatorDiffers && !payoutDiffers) { say({ node: n, update: 'not needed: its advertisement already says all of it' }); continue; }
  const advert = { ...bond.advert, guardianOf: entries, timestamp: BigInt(Date.now()),
    ...(VERSIONS ? { protocolVersions: VERSIONS } : {}), ...(ADD_APPS.length ? { hostedGames: appsWith(bond.advert.hostedGames) } : {}),
    ...(SERVING !== null ? { serving: SERVING } : {}), ...(DECLARE ? { declares: DECLARE } : {}), ...(OPERATOR ? { operatorId: OPERATOR } : {}), ...(payout ? { payoutPubkey: payout } : {}) };
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
  if (checked.advert.guardianOf.map((g) => toHex(g.guardianKey)).join(',') !== p.advert.guardianOf.map((g) => toHex(g.guardianKey)).join(',')) throw new Error(`node ${p.n}: read back other keys`);
  return { ...p, ...u, vsize: d.vsize };
}));
const accept = JSON.parse(cli('testmempoolaccept', JSON.stringify([fundingHex, ...updates.map((u) => u.hex)])));
say({ funding: fundingTx.txid, fundingFee: funded.fee, carriers: plans.length, carrierKeys: keysPath,
  accept: accept.map((a) => ({ txid: a.txid.slice(0, 16), allowed: a.allowed, why: a['reject-reason'] || null })) });
if (!accept.every((a) => a.allowed)) throw new Error('the mempool refuses a transaction above; nothing is broadcast');
for (const u of updates)
  say({ node: u.n, update: u.txid, advertId: u.advertId, bond: `${u.bond.txid}:${u.bond.vout}`, vsize: u.vsize,
    guardianOf: u.advert.guardianOf.map((g) => `${toHex(g.federationId).slice(0, 8)}:${toHex(g.guardianKey).slice(0, 10)}`) });
if (!publish) { say({ published: false, why: 'no --publish: built and checked, nothing broadcast' }); process.exit(0); }
cli('sendrawtransaction', fundingHex);
for (const u of updates) cli('sendrawtransaction', u.hex);
say({ published: true, funding: fundingTx.txid, updates: updates.map((u) => u.txid) });
