// THE SEVEN TESTNET4 BONDS, AS THE ARENA SEATS WILL COUNT THEM (kanban #209 step 4, after testnet4-reaffirm.mjs --publish):
// this tree's census derived from testnet4's own blocks for a round of testnet4's Arena network id at the tip - as roster.js
// derives it (the BIP-340 verify for updates and re-affirmations) - and each seat's bond read on chain: unspent, at its
// funding height, re-affirmed and updated. Reads only; nothing is built or sent.
//
//   node tools/testnet4-carried.mjs          (FROM=<first height read>, default 154150)
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { regtest } from './regtest-bond.mjs';
import { bondSetFor } from '../src/curve.js';
import { deriveCensus } from '../../arena-protocol/src/census.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { NETWORK_ID_TESTNET4 } from '../../arena-protocol/src/genesis-ids.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';

const env = process.env;
const home = env.ARENA_TESTNET4_DIR || `${env.HOME}/blwp-testnet4`;
const cli = (...a) => execFileSync(env.BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli',
  [`-datadir=${env.ARENA_TN4_DATADIR || '/mnt/bitcoin/tn4'}`, `-rpcwallet=${env.ARENA_TN4_BOND_WALLET || 'blwp-tn4-bonds'}`, ...a], { encoding: 'utf8', maxBuffer: 256 << 20 }).trim();
const say = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v)));
const rt = regtest(cli, { network: 'testnet4', wallet: env.ARENA_TN4_BOND_WALLET || 'blwp-tn4-bonds' });
const keyOf = (n) => { const db = new DatabaseSync(join(home, `node-${n}.db`), { readOnly: true });
  try { const r = db.prepare('SELECT secret FROM identity WHERE one = 0').get(); return new Uint8Array(r.secret); } finally { db.close(); } };

const tip = rt.height();
const from = Number(env.FROM || 154150);
const view = rt.blocksFrom(from, tip);
const byTxid = new Map();
for (const b of view.blocks) for (const raw of b.transactions) { try { byTxid.set(toHex(parseTransaction(raw).txid), raw); } catch { /* not one */ } }
const census = deriveCensus(view, {
  contract: { bondMinSats: 50000n, protocolVersion: 1, networkId: NETWORK_ID_TESTNET4, censusHeight: tip, censusConfirmations: 1, gameId: NEXTBLOCK.gameId },
  bond: bondSetFor('testnet4'), resolve: (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; },
  verifyUpdate: (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } },
});
const seats = [];
for (let n = 1; n <= 7; n++) {
  const b = rt.bondsOf(keyOf(n))[0];
  const e = (census.entries || []).find((x) => toHex([...x.txid].reverse()) === b.txid && x.vout === b.vout);
  const out = cli('gettxout', b.txid, String(b.vout));
  seats.push({ seat: n, bond: `${b.txid.slice(0, 16)}:${b.vout}`, fundedAt: b.height, unspentSats: out ? Math.round(JSON.parse(out).value * 1e8) : null,
    counted: !!e, reaffirmedAt: e && e.reaffirmedBy ? e.reaffirmedBy.height : null, updatedAt: e && e.updatedBy ? e.updatedBy.height : null,
    hostsNextblock: !!e && (e.hostedGames || []).some((g) => toHex(g) === toHex(NEXTBLOCK.gameId)) });
}
say({ tip, from, census: { ok: census.ok, why: census.why, counted: (census.entries || []).length,
  excluded: (census.excluded || []).map((x) => `${x.step}: ${x.why}`).slice(0, 8) }, seats });
process.exit(0);
