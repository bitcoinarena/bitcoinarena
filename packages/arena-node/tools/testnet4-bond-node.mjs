#!/usr/bin/env node
// ONE NODE'S FIRST BOND ON TESTNET4 (kanban #326, the owner 2026-10-15: "a 15th testnet4 node with a 50,000 sat bond" - the seat
// §23A.6 draws into federation B's successor beside B1-B6, seated first). The node's key is read from its own store (created
// here if the store is new, as the node would at its first start), and its first template-2 bond is posted with the
// advertisement named below: its own operator, guardian-capable with its public guardian endpoint, guarding nothing yet.
// It broadcasts and returns; the census counts the bond once it is buried (six deep at the census height).
//
//   BITCOIN_CLI=<bitcoin-cli> BTC_DATADIR=<dir> WALLET=<wallet> STORE=<node store> ENDPOINT=wss://... GUARDIAN_ENDPOINT=wss://.../guardian \
//   OPERATOR=<id> [BOND_SATS=50000] [FUND_BTC=0.00056] [PROTOCOLS=1,2,3,4,5,6,7] [HOSTED=<hex,hex,..>] node tools/testnet4-bond-node.mjs [--publish]
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { regtest } from './regtest-bond.mjs';
import { openStore, nodeIdentity } from '../src/store.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const env = process.env;
for (const k of ['BITCOIN_CLI', 'BTC_DATADIR', 'WALLET', 'STORE', 'ENDPOINT', 'GUARDIAN_ENDPOINT', 'OPERATOR']) if (!env[k]) throw new Error(`${k} is needed`);
const publish = process.argv.includes('--publish');
const cli = (...a) => execFileSync(env.BITCOIN_CLI, [`-datadir=${env.BTC_DATADIR}`, ...(['listwallets', 'createwallet', 'loadwallet', 'getblockcount', 'getblockhash', 'getblock', 'decodescript', 'decoderawtransaction', 'sendrawtransaction', 'getrawtransaction', 'getblockchaininfo', 'testmempoolaccept'].includes(a[0]) ? [] : [`-rpcwallet=${env.WALLET}`]), ...a], { encoding: 'utf8', maxBuffer: 256 << 20 }).trim();
const rt = regtest(cli, { network: 'testnet4', wallet: env.WALLET });
const fresh = !existsSync(env.STORE);
const db = openStore(env.STORE);
const id = nodeIdentity(db);
const secret = new Uint8Array(db.prepare('SELECT secret FROM identity WHERE one = 0').get().secret);
const out = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v)));
out({ step: 'node', store: env.STORE, fresh, pubkey: toHex(id.pubkey), tip: rt.height() });
const have = rt.bondsOf({ pubkey: id.pubkey });
if (have.length) { out({ step: 'refused', why: `this node already has ${have.length} bond(s) on chain - a node is bonded once; publish an advertisement update instead`, bonds: have.map((b) => `${b.txid}:${b.vout}`) }); process.exit(2); }
// NO DRY RUN THAT BUILDS: postBond funds its carrier at once (bitcoind `send`), so a bond built and not published would strand
// that funding - without --publish this prints what it would post and stops before any coin moves
const plan = { operatorId: env.OPERATOR, endpoint: env.ENDPOINT, guardianEndpoint: env.GUARDIAN_ENDPOINT, bondSats: env.BOND_SATS || '50000',
  fundBtc: env.FUND_BTC || '0.00056', protocols: env.PROTOCOLS || '1,2,3,4,5,6,7', hosted: String(env.HOSTED || '').split(',').filter(Boolean).length,
  walletTrusted: JSON.parse(cli('getbalances')).mine.trusted };
if (!publish) { out({ step: 'plan (nothing built, nothing sent): --publish to post', ...plan }); process.exit(0); }
const hosted = String(env.HOSTED || '').split(',').filter(Boolean).map((h) => fromHex(h)).sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
const p = rt.postBond(secret, {
  endpoint: env.ENDPOINT, guardianCapable: true, guardianEndpoint: env.GUARDIAN_ENDPOINT, guardianOf: [],
  operatorId: env.OPERATOR, protocolVersions: String(env.PROTOCOLS || '1,2,3,4,5,6,7').split(',').map(Number),
  ...(hosted.length ? { hostedGames: hosted } : {}),
  bondSats: BigInt(env.BOND_SATS || 50000), fundBtc: env.FUND_BTC || '0.00056',
});
const accept = JSON.parse(cli('testmempoolaccept', JSON.stringify([p.hex])))[0];
out({ step: 'bond built', txid: p.txid, bondSats: p.bondSats, maturity: p.maturity, operatorId: p.advert.operatorId, protocolVersions: p.advert.protocolVersions,
  endpoint: p.advert.endpoint, guardianEndpoint: p.advert.guardianEndpoint, hostedGames: p.advert.hostedGames.length, vsize: JSON.parse(cli('decoderawtransaction', p.hex)).vsize,
  mempoolAccept: accept.allowed, why: accept['reject-reason'] || null });
if (!accept.allowed) { out({ step: 'not published: refused by the mempool - its carrier funding is in the wallet\'s history', funding: 'see gettransaction' }); process.exit(1); }
out({ step: 'published', txid: cli('sendrawtransaction', p.hex), at: new Date().toISOString() });
