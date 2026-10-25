// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ADD TO BOND ON A TESTNET4 SEAT (kanban #544, 2026-10-19: "this is also the default way. E.g increase your bond by 32000
// sats"): what `arena-install --add-bond` does for an installed node, for one of the hand-made seats - a SECOND bond output beside
// the seat's first, its body the seat's own newest advertisement (bondsOf: hosted games, guardian_of, versions, endpoint) with the
// new output's template-2 height, the first bond untouched. From protocol 19 the census counts both as one entry of their sum.
//
// Paid from the bond wallet: one funding transaction to the carrier (walletcreatefundedpsbt, include_unsafe), then the bond
// transaction. Without --publish both are built and checked with testmempoolaccept, nothing broadcast.
//
//   ARENA_ADD_BOND_NODE=1 ARENA_ADD_BOND_SATS=32000 [ARENA_ADD_BOND_SLACK=6] node tools/testnet4-add-bond.mjs [--publish]
//
// --census <height>: the measurement - the census at <height> derived from this bitcoind's blocks (from the node's oldest
// template-2 bond on, or ARENA_ADD_BOND_FROM), scanned as a seat scans it (no candidate list), under protocol 18 and protocol 19,
// and what each says of the node: its outputs, which are in, and the sum (ARENA_ADD_BOND_VERSIONS, default 16,18,19).
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { regtest } from './regtest-bond.mjs';
import { openStore, nodeIdentity } from '../src/store.js';
import { bondSetFor } from '../src/curve.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { splitBlock } from '../../arena-protocol/src/block.js';
import { advertInTransaction, deriveCensus, nodeBondOf } from '../../arena-protocol/src/census.js';
import { recognizeBond } from '../../arena-protocol/src/chain.js';
import { NETWORK_ID_TESTNET4 } from '../../arena-protocol/src/genesis-ids.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '../../arena-protocol/src/constants.js';

const env = process.env;
const publish = process.argv.includes('--publish');
const censusAt = process.argv.includes('--census') ? Number(process.argv[process.argv.indexOf('--census') + 1]) : null;
const home = env.ARENA_TESTNET4_DIR || `${env.HOME}/blwp-testnet4`;
const datadir = env.ARENA_TN4_DATADIR || '/mnt/bitcoin/tn4';
const wallet = env.ARENA_TN4_BOND_WALLET || 'blwp-tn4-bonds';
const N = Number(env.ARENA_ADD_BOND_NODE || 1);
const SATS = BigInt(env.ARENA_ADD_BOND_SATS || 32000);
const CARRIER_FEE = 3000n;
const cli = (...a) => execFileSync(env.BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli',
  [`-datadir=${datadir}`, `-rpcwallet=${wallet}`, ...a], { encoding: 'utf8', maxBuffer: 256 << 20 }).trim();
const say = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v)));

const rt = regtest(cli, { network: 'testnet4', wallet });
const db = openStore(join(home, `node-${N}.db`));
const { secret, pubkey } = nodeIdentity(db);
db.close?.();
const bonds = rt.bondsOf(secret);
if (!bonds.length) throw new Error(`node ${N} (${toHex(pubkey).slice(0, 8)}) has no confirmed unspent bond to add to`);
say({ node: N, nodeKey: toHex(pubkey).slice(0, 16), bonds: bonds.map((b) => ({ outpoint: `${b.txid}:${b.vout}`, sats: b.sats, height: b.height, maturity: b.maturity,
  operator: b.advert.operatorId, updatedBy: b.updatedBy || null })) });

if (censusAt !== null) {
  // THE MEASUREMENT: blocks from the node's oldest bond to the census height, the census at that height under 18 and 19
  const from = Number(env.ARENA_ADD_BOND_FROM || Math.min(...bonds.filter((b) => b.advert.bondScriptTemplateVersion === 2).map((b) => b.height)));
  const blocks = [];
  for (let h = from; h <= censusAt; h++) blocks.push(splitBlock(fromHex(cli('getblock', cli('getblockhash', String(h)), '0'))));
  const view = { blocks, firstHeight: from };
  const byTxid = new Map();
  for (const b of blocks) for (const raw of b.transactions) byTxid.set(toHex(parseTransaction(raw).txid), raw);
  const resolve = (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; };
  const me = toHex(pubkey);
  for (const protocolVersion of String(env.ARENA_ADD_BOND_VERSIONS || '16,18,19').split(',').map(Number)) {
    const contract = { bondMinSats: BigInt(env.ARENA_ADD_BOND_FLOOR || 50000), protocolVersion, networkId: NETWORK_ID_TESTNET4, censusHeight: censusAt, censusConfirmations: 6 };
    const c = deriveCensus(view, { contract, resolve, bond: bondSetFor('testnet4'),
      verifyUpdate: (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } } });
    if (!c.ok) { say({ protocolVersion, census: 'not derived', why: c.why }); continue; }
    const mine = c.entries.filter((e) => toHex(e.pubkey) === me);
    const node = nodeBondOf(c.entries, me);
    say({ protocolVersion, censusHeight: censusAt, from, root: toHex(c.root).slice(0, 16), entries: c.entries.length, floor: contract.bondMinSats, entriesOfNode: mine.map((e) => `${toHex(Uint8Array.from(e.txid).reverse())}:${e.vout}=${e.bondSats}`),
      node: node ? { bondSats: node.bondSats, outputs: node.outputs.length } : null,
      excluded: c.excluded.filter((e) => toHex(e.pubkey || new Uint8Array()) === me).map((e) => ({ outpoint: `${toHex(Uint8Array.from(e.txid).reverse())}:${e.vout}`, step: e.step, why: e.why })) });
  }
  process.exit(0);
}

// THE ADDED OUTPUT: the seat's newest advertisement, a template-2 bond of SATS, its carrier funded by the bond wallet (not sent yet)
const newest = bonds[0];
let fundingHex = null;
// the versions it speaks: the newest advertisement's and this build's (protocol 19 counts the sum only for a node that speaks 19)
const versions = [...new Set([...(newest.advert.protocolVersions || []), ...SUPPORTED_PROTOCOL_VERSIONS])].sort((a, b) => a - b);
// ARENA_ADD_BOND_SLACK: the blocks the new bond may wait for a miner and still count (default 6; kanban #495 used 144)
const made = rt.postBond(secret, { advert: { ...newest.advert, protocolVersions: versions }, bondSats: SATS, slackBlocks: Number(env.ARENA_ADD_BOND_SLACK || 6), utxo: (spk) => {
  const address = JSON.parse(cli('decodescript', toHex(spk))).address;
  const value = SATS + 330n + CARRIER_FEE + 1000n;
  const funded = JSON.parse(cli('-named', 'walletcreatefundedpsbt', 'inputs=[]', `outputs=${JSON.stringify([{ [address]: Number(value) / 1e8 }])}`,
    `options=${JSON.stringify({ include_unsafe: true, fee_rate: 2 })}`));
  const final = JSON.parse(cli('finalizepsbt', JSON.parse(cli('walletprocesspsbt', funded.psbt)).psbt));
  if (!final.complete) throw new Error('the funding transaction did not sign');
  fundingHex = final.hex;
  const d = JSON.parse(cli('decoderawtransaction', fundingHex));
  return { txid: d.txid, vout: d.vout.find((o) => o.scriptPubKey.hex === toHex(spk)).n, value };
} });
const tx = parseTransaction(fromHex(made.hex));
const advert = advertInTransaction(tx);
if (!advert || toHex(advert.nodePubkey) !== toHex(pubkey) || advert.operatorId !== newest.advert.operatorId)
  throw new Error('the added bond\'s body does not read back as this node\'s advertisement');
const seen = recognizeBond(tx, 0, advert, { network: 'testnet4', bond: bondSetFor('testnet4') });
if (!seen.ok) throw new Error(`the added bond is not recognised: ${seen.why}`);
const accept = JSON.parse(cli('testmempoolaccept', JSON.stringify([fundingHex, made.hex])));
const fundingTxid = JSON.parse(cli('decoderawtransaction', fundingHex)).txid;
say({ node: N, add: SATS, funding: fundingTxid, bond: made.txid, maturity: made.maturity, operator: advert.operatorId, hosts: advert.hostedGames.length,
  guardianOf: advert.guardianOf.length, endpoint: advert.endpoint, versions: advert.protocolVersions,
  first: { outpoint: `${newest.txid}:${newest.vout}`, sats: newest.sats, untouched: !tx.inputs.some((i) => toHex(Uint8Array.from(i.previousTxid).reverse()) === newest.txid) },
  accept: accept.map((a) => ({ txid: a.txid.slice(0, 16), allowed: a.allowed, why: a['reject-reason'] || null, vsize: a.vsize, fee: a.fees && a.fees.base })) });
if (!accept.every((a) => a.allowed)) throw new Error('the mempool refuses a transaction above; nothing is broadcast');
if (!publish) { say({ published: false, why: 'no --publish: built and checked, nothing broadcast' }); process.exit(0); }
cli('sendrawtransaction', fundingHex);
cli('sendrawtransaction', made.hex);
say({ published: true, funding: fundingTxid, bond: made.txid, rawFunding: fundingHex, rawBond: made.hex });
