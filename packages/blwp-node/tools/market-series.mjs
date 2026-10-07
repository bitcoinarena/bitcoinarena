// A PAID MARKET AS A PUBLISHED SERIES ON REGTEST (kanban #206, the owner 2026-10-07 23:23, decision A): the lobby offers a paid
// row only for a round of a series (lobby.js paidSeriesOnly), so the harness stands the regtest market up the way the live
// paid rounds stand: seven bonded seats, one series published with OP_RETURN "BLW SERIES" below its beacon, held by the seats
// (BLWP_SERIES_FILE). Regtest runs the mainnet series clock (series.js): a series starts on genesis_series_start + k x 24 h,
// its committee_time 72 h before - so this runs while the chain is still mined in the past (market-series-regtest.sh), and
// the chain is brought to the present after the publication, which is then below the series' beacon.
//
//   node tools/market-series.mjs bonds   - the seven seats' regtest bonds, as round-2of2's standUpRound posts them (so its
//                                          attach mode later finds them as bonded), the market among their hosted games
//   node tools/market-series.mjs series  - the series template (today's series; the market's game, no core, no config, the
//                                          federation, the seven seats, the census at the tip), its publication, the file
//
// Env: SEAT_PORTS (seven), SEAT_DIR (node-<i>.db), BITCOIN_CLI_ARGS (bitcoin-cli args, the wallet's), CLIENT_DIR (the lock
// port's joined client), LOCK_BIN, STAKE_MSAT, OUT (the series file). Never testnet4: regtest only, no other bond.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { regtest } from './regtest-bond.mjs';
import { guardianFieldsFromNode } from './round-2of2.mjs';
import { openStore, nodeIdentity } from '../src/store.js';
import { stakeLockPort } from '../src/stake-lock-port.js';
import { bondSetFor } from '../src/curve.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { MARKET } from '../test/plugins/market/index.js';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId } from '../../protocol/src/donation.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { encodeRoundContract, decodeRoundContract } from '../../protocol/src/contracts.js';
import { deriveCensus } from '../../protocol/src/census.js';
import { parseTransaction } from '../../protocol/src/tx.js';
import { seriesTemplate, seriesLeadIsValid, seriesId, seriesPublicationPayload, genesisSeriesStart, SERIES_MAX_MS } from '../../protocol/src/series.js';
import { toHex } from '../../protocol/src/hash.js';

const env = process.env;
const mode = process.argv[2];
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const cli = (...a) => execFileSync(env.BITCOIN_CLI, [...env.BITCOIN_CLI_ARGS.split(/[ ,]/).filter(Boolean), ...a], { encoding: 'utf8' }).trim();
const ports = env.SEAT_PORTS.split(',').map(Number);
if (ports.length !== 7) throw new Error('seven seats');
const host = '127.0.0.1';
const storeOf = (i) => `${env.SEAT_DIR}/node-${i + 1}.db`;
const keyOf = (i) => { const db = openStore(storeOf(i)); try { return nodeIdentity(db); } finally { if (db.close) db.close(); } };
const HOSTED = [NEXTBLOCK.gameId, MARKET.registration.gameId].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
const rt = regtest(cli, { network: 'regtest', wallet: env.WALLET || 'tn4rt' });
const lock = stakeLockPort({ bin: env.LOCK_BIN, dataDir: env.CLIENT_DIR });

// EACH SEAT'S GUARDIAN KEY, as run-testnet4-paid.mjs reads it: its own peer id beside its store, in the federation's config
async function guardianOfAll() {
  const fed = await lock.guardians();
  if (fed.keys.length !== 7) throw new Error(`the federation has ${fed.keys.length} guardians, not 7`);
  const of = ports.map((_, i) => {
    const dir = `${storeOf(i)}.guardian`;
    const id = JSON.parse(readFileSync(`${dir}/local.json`, 'utf8')).identity;
    const own = JSON.parse(readFileSync(`${dir}/consensus.json`, 'utf8')).broadcast_public_keys[String(id)];
    const key = fed.keys.find((k) => toHex(k) === own);
    if (!key) throw new Error(`${dir}: its guardian's key is not the federation's`);
    return [{ federationId: fed.federationId, guardianKey: key }];
  });
  return { fed, of };
}

if (mode === 'bonds') {
  const { fed, of } = await guardianOfAll();
  const posted = [];
  for (const [i, port] of ports.entries()) {
    const id = keyOf(i);
    const guardian = await guardianFieldsFromNode(`http://${host}:${port}`);
    // AS standUpRound POSTS IT (round-2of2.mjs): the endpoint it advertises, the guardian it runs, the games it hosts
    posted.push(rt.postBond(id.secret, { endpoint: env[`BLWP_WSS_${port}`] || `ws://${host}:${port}`, guardianOf: of[i], ...guardian, hostedGames: HOSTED }));
  }
  rt.include(posted.map((p) => p.hex));
  const bondHeight = rt.height();
  rt.mine(6);
  say({ step: 'bonds', federation: toHex(fed.federationId).slice(0, 16), bonds: posted.length, bondHeight, censusHeight: rt.height(),
    hosted: HOSTED.map((g) => toHex(g).slice(0, 8)) });
} else if (mode === 'series') {
  const { fed } = await guardianOfAll();
  const H = rt.height();
  const nodes = ports.map((_, i) => keyOf(i).pubkey);
  // TODAY'S SERIES: the one whose 24 h holds now (its rounds every 90 s), committee_time 72 h before its start
  const g = genesisSeriesStart(NETWORK_ID_REGTEST);
  const k = Number((BigInt(Date.now()) - g) / SERIES_MAX_MS);
  const contract = {
    networkId: NETWORK_ID_REGTEST, configHash: new Uint8Array(32), censusConfirmations: 1,
    gameVerifySlots: 7, settlementSlots: 7, gameId: MARKET.registration.gameId, simCoreHash: new Uint8Array(32),
    committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 0n, entryCloseMs: 0n,
    objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
    federationId: fed.federationId, stakeExpiryBlocks: 144,
    publicationRelays: ports.map((p) => `http://${host}:${p}`),
    donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: H, censusRoot: new Uint8Array(32),
    stakeMsat: BigInt(env.STAKE_MSAT || 1000000), bondMinSats: 50000n, blockTicks: 4920,
    exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150,
    minScore: 0, rankNumerator: 3, rankDenominator: 4, nodes,
  };
  const template = seriesTemplate(contract, k);
  const lead = seriesLeadIsValid(template);
  if (!lead.ok) throw new Error(lead.why);
  // THE CENSUS AT THE TIP, from the chain the seats read (the bonds are six deep here)
  const view = rt.blocksFrom(Math.max(0, H - 60), H);
  const byTxid = new Map();
  for (const block of view.blocks) for (const raw of block.transactions || []) { try { byTxid.set(toHex(parseTransaction(raw).txid), raw); } catch { /* not one */ } }
  const census = deriveCensus(view, { contract: decodeRoundContract(encodeRoundContract(template)), bond: bondSetFor('regtest'),
    resolve: (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; } });
  if (!census.ok) throw new Error(`no census at ${H}: ${census.why}`);
  template.censusRoot = census.root;
  const tipTime = BigInt(JSON.parse(cli('getblockheader', cli('getbestblockhash'))).mediantime) * 1000n;
  if (template.committeeTimeMs <= tipTime + 3600000n)
    throw new Error(`committee_time ${template.committeeTimeMs} is not an hour past the tip's median ${tipTime}: the chain is not far enough in the past`);
  const id = seriesId(template);
  const payload = seriesPublicationPayload(id);
  // THE PUBLICATION, as testnet4-series.mjs makes it: one wallet output, an OP_RETURN, mined in the next (past) block
  const raw = cli('createrawtransaction', '[]', JSON.stringify([{ data: toHex(payload) }]));
  const funded = JSON.parse(cli('fundrawtransaction', raw, JSON.stringify({ fee_rate: 2 })));
  const signed = JSON.parse(cli('signrawtransactionwithwallet', funded.hex));
  const txid = cli('sendrawtransaction', signed.hex);
  rt.mine(1);
  writeFileSync(env.OUT, toHex(encodeRoundContract(template)) + '\n');
  say({ step: 'series', id: toHex(id), k, census: H, censusMembers: census.members ? census.members.length : undefined,
    seriesStart: new Date(Number(template.startTimeMs)).toISOString(), committeeTime: new Date(Number(template.committeeTimeMs)).toISOString(),
    tipMedian: new Date(Number(tipTime)).toISOString(), publication: txid, publishedAt: rt.height(), file: env.OUT });
} else throw new Error('market-series.mjs bonds | series');
process.exit(0);
