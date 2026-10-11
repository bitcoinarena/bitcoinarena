// EACH TESTNET4 SEAT'S GET /bond AND GET /headers, WRITTEN FROM THE CHAIN (kanban #295). A seat serves its attach-proof
// directory (main.js ARENA_ATTACH_PROOF_DIR): bond.json - its bond transaction, the merkle branch and its position - and
// headers.bin - the headers from testnet4's anchor (154000) up. After the re-bond each seat's bond is a template-2 bond of
// this network (no re-affirmation, no update beside it), in a block the old headers.bin (to 155872) did not reach. This
// writes both again from bitcoind for each node's newest bond, and checks each proof against the headers it writes before
// it replaces anything: the old files stay as *.pre-295, and advert-update.json (an update of the old bond) moves aside,
// so the seat's own advertisement is the one its bond commits to.
//
// Without --write it prints what it would write and checks it, writing nothing. --check-only TXID:VOUT for one bond reads
// that bond instead of the newest (used to compare against the file a seat serves now).
//   node tools/testnet4-attach-proof.mjs [--write]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { regtest } from './regtest-bond.mjs';
import { openStore, nodeIdentity } from '../src/store.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { merkleBranchOf, provesTransaction, TESTNET4_ANCHOR_HEIGHT, TESTNET4_ANCHOR, blockHashOf } from '../../arena-protocol/src/chain.js';
import { advertInTransaction } from '../../arena-protocol/src/census.js';

const env = process.env;
const write = process.argv.includes('--write');
const home = env.ARENA_TESTNET4_DIR || `${env.HOME}/blwp-testnet4`;
const datadir = env.ARENA_TN4_DATADIR || '/mnt/bitcoin/tn4';
const wallet = env.ARENA_TN4_BOND_WALLET || 'blwp-tn4-bonds';
const NODES = (env.ARENA_REBOND_NODES || '1,2,3,4,5,6,7').split(',').map(Number);
const cli = (...a) => execFileSync(env.BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli',
  [`-datadir=${datadir}`, `-rpcwallet=${wallet}`, ...a], { encoding: 'utf8', maxBuffer: 256 << 20 }).trim();
const say = (o) => console.log(JSON.stringify(o));
const rt = regtest(cli, { network: 'testnet4', wallet });

/** bond.json for one outpoint in a block at `height`: its transaction, its branch, its position. */
export function proofAt(txidHex, height) {
  const block = JSON.parse(cli('getblock', cli('getblockhash', String(height)), '1'));
  const pos = block.tx.indexOf(txidHex);
  if (pos < 0) throw new Error(`${txidHex} is not in block ${height}`);
  const branch = merkleBranchOf(block.tx.map((t) => fromHex(t).reverse()), pos);
  return { hex: cli('getrawtransaction', txidHex, 'false', block.hash), merkle: branch.map(toHex), pos };
}

// THE HEADERS, ANCHOR TO TIP, ONE BUFFER (80 bytes each), read in one batch per 500
const tip = rt.height();
const parts = [];
for (let h = TESTNET4_ANCHOR_HEIGHT; h <= tip; h++) parts.push(Buffer.from(cli('getblockheader', cli('getblockhash', String(h)), 'false'), 'hex'));
const headers = Buffer.concat(parts);
if (toHex(blockHashOf(new Uint8Array(parts[0]))) !== toHex(TESTNET4_ANCHOR)) throw new Error('the first header is not testnet4\'s anchor');
const headerOf = (height) => new Uint8Array(parts[height - TESTNET4_ANCHOR_HEIGHT]);

for (const n of NODES) {
  const db = openStore(join(home, `node-${n}.db`));
  const { secret } = nodeIdentity(db);
  db.close?.();
  const bond = rt.bondsOf(secret)[0];
  if (!bond) throw new Error(`node ${n}: no confirmed unspent bond`);
  const proof = proofAt(bond.txid, bond.height);
  const proves = provesTransaction(headerOf(bond.height), fromHex(bond.txid).reverse(), proof.merkle.map(fromHex), proof.pos);
  const advert = advertInTransaction(fromHex(proof.hex));
  const dir = join(home, 'paid', `attach-proof-${n}`);
  say({ node: n, bond: `${bond.txid}:${bond.vout}`, height: bond.height, template: bond.advert.bondScriptTemplateVersion, maturity: bond.maturity,
    ancestor: !!bond.ancestor, proves, advertCommitted: !!advert, endpoint: advert && advert.endpoint, headers: `${TESTNET4_ANCHOR_HEIGHT}..${tip}`,
    dir, write });
  if (!proves || !advert) throw new Error(`node ${n}: the proof does not hold; nothing is written`);
  if (bond.ancestor) throw new Error(`node ${n}: its newest bond is still the carried one; re-bond first (testnet4-rebond.mjs)`);
  if (!write) continue;
  for (const f of ['bond.json', 'headers.bin', 'advert-update.json'])
    if (existsSync(join(dir, f)) && !existsSync(join(dir, `${f}.pre-295`))) renameSync(join(dir, f), join(dir, `${f}.pre-295`));
  writeFileSync(join(dir, 'bond.json'), JSON.stringify(proof));
  writeFileSync(join(dir, 'headers.bin'), headers);
}
say({ tip, headerCount: parts.length, written: write });
