#!/usr/bin/env node
/**
 * THE FIRST BITCOIN ARENA SERIES ON TESTNET4 (kanban #209 step 6; spec 0A.9): the last BLWP series' contract carried onto
 * the Arena layout - the same core and config, seats, federation, relays, stake (100 sat, 8172fffd's), run and rank - under
 * testnet4's Arena network id, naming nextblock's game id and the donation key set in force (re-signed under the Arena id),
 * its census derived from testnet4's own blocks as the seats derive it (roster.js: the BIP-340 verify for re-affirmations
 * and updates - the seven carried bonds).
 *
 * The clock (§5A.5, testnet4): series k starts at genesis_series_start + k x 24 h; its census is the highest block whose
 * MTP <= start - 36 h, so the series can be published only once that cut has passed; its committee_time is start - 24 h,
 * which must be an hour past the tip's MTP. SERIES_K names k; unnamed, the first series whose census cut has passed and
 * whose committee_time is still an hour ahead.
 *
 * The publication spends ONE wallet output chosen here, never a bond or a marker, as testnet4-series.mjs does. Without
 * --send it builds and checks everything and broadcasts nothing; with it, it broadcasts, writes the template beside it and
 * adds it to the seats' series file (ARENA_SERIES_FILE, read again by the seats without a restart).
 *
 *   BASE_SERIES_FILE=<the BLWP series file> PHASE0_PROTOCOL=<a phase0 tree's packages/protocol/src> \
 *     node tools/testnet4-arena-series.mjs <out dir> [--send]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { encodeRoundContract, decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { deriveCensus } from '../../arena-protocol/src/census.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { splitBlock } from '../../arena-protocol/src/block.js';
import { NETWORK_ID_TESTNET4 } from '../../arena-protocol/src/genesis-ids.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { TESTNET4_DONATION_SET_KEYS } from '../../arena-protocol/src/testnet4-donation-set-keys.js';
import { seriesTemplate, seriesLeadIsValid, seriesId, seriesPublicationPayload, seriesClockFor, genesisSeriesStart, SERIES_MAX_MS } from '../../arena-protocol/src/series.js';
import { bondSetFor } from '../src/curve.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';

const [outDir, send] = process.argv.slice(2);
if (!outDir) { console.error('usage: testnet4-arena-series.mjs <out dir> [--send]'); process.exit(2); }
const env = process.env;
const cli = (...a) => execFileSync(env.ARENA_BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli',
  [`-datadir=${env.ARENA_TN4_DATADIR || '/mnt/bitcoin/tn4'}`, ...a], { encoding: 'utf8', maxBuffer: 256 << 20 }).trim();
const wallet = (...a) => cli(`-rpcwallet=${env.ARENA_TN4_WALLET || 'blwp-tn4-bonds'}`, ...a);
const say = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v)));

// 1. THE LAST BLWP SERIES' CONTRACT, read by the BLWP network's own code
const p0 = await import(`${env.PHASE0_PROTOCOL || '/home/operator/blwp-testnet4/code-seat232/packages/protocol/src'}/contracts.js`);
const lines = readFileSync(env.BASE_SERIES_FILE || '/home/operator/blwp-testnet4/series/series-both.txt', 'utf8').trim().split('\n');
const base = p0.decodeRoundContract(fromHex(lines[lines.length - 1].trim()));

// 2. WHICH SERIES: its census cut passed, its committee_time an hour ahead of the tip's median
const { censusLeadMs, committeeLeadMs } = seriesClockFor(NETWORK_ID_TESTNET4);
const g = genesisSeriesStart(NETWORK_ID_TESTNET4);
const mtpOf = (h) => BigInt(JSON.parse(cli('getblockheader', cli('getblockhash', String(h)))).mediantime) * 1000n;
const tip = Number(cli('getblockcount'));
const tipMtp = mtpOf(tip);
const startOf = (k) => g + BigInt(k) * SERIES_MAX_MS;
let k = env.SERIES_K !== undefined ? Number(env.SERIES_K) : Number((tipMtp - g) / SERIES_MAX_MS);
if (env.SERIES_K === undefined) while (startOf(k) - censusLeadMs > tipMtp || startOf(k) - committeeLeadMs <= tipMtp + 3600000n) {
  if (startOf(k) - committeeLeadMs <= tipMtp + 3600000n) k++; else break;
}
const cut = startOf(k) - censusLeadMs;
// DRY_AT_TIP=1: the whole path checked now, the census taken at the tip instead of at the cut - never with --send
const dryAtTip = env.DRY_AT_TIP === '1';
if (dryAtTip && send === '--send') throw new Error('DRY_AT_TIP is a check only; it never publishes');
if (cut > tipMtp && !dryAtTip) {
  say({ step: 'not yet', k, seriesStart: new Date(Number(startOf(k))).toISOString(), censusCut: new Date(Number(cut)).toISOString(),
    tip, tipMtp: new Date(Number(tipMtp)).toISOString(), why: 'the census cut has not passed: its census block is not known yet' });
  process.exit(3);
}
// the census: the highest block whose MTP <= the cut
let H = tip; if (!dryAtTip) while (mtpOf(H) > cut) H--;

// 3. THE ARENA CONTRACT: the BLWP series' fields, on testnet4's Arena id, nextblock, the key set in force
const contract = {
  ...base, networkId: NETWORK_ID_TESTNET4, gameId: NEXTBLOCK.gameId,
  donationSetId: donationSetId(TESTNET4_DONATION_SET_KEYS.recipients), censusHeight: H, censusRoot: new Uint8Array(32),
};
delete contract.seriesId;
// THE CENSUS AT H, as the seats derive it, from testnet4's blocks
const from = Number(env.CENSUS_FROM || 154150);
const blocks = [];
for (let h = from; h <= H; h++) { const { header, transactions } = splitBlock(fromHex(cli('getblock', cli('getblockhash', String(h)), '0'))); blocks.push({ header, transactions }); }
const view = { blocks, firstHeight: from };
const byTxid = new Map(); for (const b of blocks) for (const raw of b.transactions) { try { byTxid.set(toHex(parseTransaction(raw).txid), raw); } catch { /* */ } }
const template0 = seriesTemplate(contract, k);
const census = deriveCensus(view, { contract: decodeRoundContract(encodeRoundContract(template0)), bond: bondSetFor('testnet4'),
  resolve: (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; },
  verifyUpdate: (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } } });
if (!census.ok) throw new Error(`no census at ${H}: ${census.why}`);
const template = seriesTemplate({ ...contract, censusRoot: census.root }, k);
const lead = seriesLeadIsValid(template);
if (!lead.ok) throw new Error(lead.why);
if (template.committeeTimeMs <= tipMtp + 3600000n) throw new Error('committee_time is not an hour past the tip\'s median: the publication could miss its beacon');
const id = seriesId(template);
const payload = seriesPublicationPayload(id);
say({ step: 'series', id: toHex(id), k, census: H, censusRoot: toHex(census.root).slice(0, 16), counted: census.entries.length,
  seriesStart: new Date(Number(template.startTimeMs)).toISOString(), committeeTime: new Date(Number(template.committeeTimeMs)).toISOString(),
  stakeMsat: template.stakeMsat, core: toHex(template.simCoreHash).slice(0, 8), config: toHex(template.configHash).slice(0, 8),
  donationSet: toHex(template.donationSetId).slice(0, 16), nodes: template.nodes.length, tip, tipMtp: new Date(Number(tipMtp)).toISOString() });

// 4. THE PUBLICATION: ONE WALLET OUTPUT, NEVER A BOND OR A MARKER
const utxos = JSON.parse(wallet('listunspent', '1')).filter((u) => u.spendable && u.solvable
  && ![50000, 1670, 330, 3000].includes(Math.round(u.amount * 1e8)) && u.amount * 1e8 >= 5000).sort((a, b) => a.amount - b.amount);
if (!utxos.length) throw new Error('no confirmed non-bond output of at least 5000 sat in the wallet');
const input = utxos[0];
const raw = wallet('createrawtransaction', JSON.stringify([{ txid: input.txid, vout: input.vout }]), JSON.stringify([{ data: toHex(payload) }]));
const funded = JSON.parse(wallet('fundrawtransaction', raw, JSON.stringify({ add_inputs: false, fee_rate: 2, changePosition: 1 })));
const signed = JSON.parse(wallet('signrawtransactionwithwallet', funded.hex));
if (!signed.complete) throw new Error('the wallet could not sign the publication');
const decoded = JSON.parse(cli('decoderawtransaction', signed.hex));
if (decoded.vin.length !== 1 || decoded.vin[0].txid !== input.txid || decoded.vin[0].vout !== input.vout) throw new Error('the publication spends something other than the one output chosen');
const accept = JSON.parse(cli('testmempoolaccept', JSON.stringify([signed.hex])))[0];
say({ step: 'publication', input: `${input.txid}:${input.vout}`, inputSats: Math.round(input.amount * 1e8), feeSats: Math.round(funded.fee * 1e8),
  txid: decoded.txid, vsize: decoded.vsize, mempoolAccept: accept.allowed, reject: accept['reject-reason'] || null });
if (!accept.allowed) throw new Error('the mempool refuses the publication; nothing is broadcast');
if (send !== '--send') { say({ sent: false, why: 'no --send: built and checked, nothing broadcast' }); process.exit(0); }
const txid = cli('sendrawtransaction', signed.hex);
mkdirSync(outDir, { recursive: true });
const hex = toHex(encodeRoundContract(template));
writeFileSync(join(outDir, `arena-series-${toHex(id).slice(0, 8)}.txt`), hex + '\n');
writeFileSync(join(outDir, `arena-series-${toHex(id).slice(0, 8)}.publication`), txid + '\n');
if (env.ARENA_SERIES_FILE) appendFileSync(env.ARENA_SERIES_FILE, hex + '\n');
say({ sent: true, txid, series: toHex(id), file: join(outDir, `arena-series-${toHex(id).slice(0, 8)}.txt`), seatsFile: env.ARENA_SERIES_FILE || null });
process.exit(0);
