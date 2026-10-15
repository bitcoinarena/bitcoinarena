#!/usr/bin/env node
// ONE WHOLE GOVERNANCE CYCLE ON A PRIVATE REGTEST (spec §27A.7.4: "regtest runs 1 / 6 / 1 blocks and two operators can drive a
// whole governance cycle through to activation in under a minute"; kanban #329). Never testnet4, nothing paid, no bond anywhere
// but this chain's own.
//
//   BITCOIN_BIN=<dir with bitcoind, bitcoin-cli> WORK=<empty dir> [RPCPORT=29411] [SEAT_PORT=29421] node tools/ballot-regtest.mjs
//   (from packages/arena-node)
//
// Three seats - `node src/main.js`, each its own store and identity - bonded at 50, 30 and 20 M sat, reading this bitcoind, with
// regtest's KEYED donation set (ARENA_REGTEST_DONATION_SET=keys: a deposit is a Bitcoin output per key, option A) and the lowest
// bracket's bond_min at 100 000 sat (a deposit of at most 1 000). Then, one JSON line per reading:
//   1  a round of the genesis config (2170f250), created before anything is proposed
//   2  a DESIGN proposal 2170f250 -> f51759b6 (nextblock's v3 bytes, a config the truck installs) with its deposit to the set,
//      posted to every seat; votes from the seats' operator vote doors (POST /operator/vote), sent by this wallet: seat 1 NO and
//      then YES (the last vote by height wins), seat 2 ABSTAIN, seat 3 YES one block after the phase (not counted)
//   3  the tally in GET /proposals at the end of voting, cooldown, and GET /config at activation
//   4  the rounds: created after the activation naming the new hash (taken) or the old one (refused by name); created before it
//      naming the old one (taken, before and after) or the new one (refused)
//   5  a forward proposal on the repeal's short schedule (refused), then the repeal f51759b6 -> 2170f250 (the genesis bytes) on
//      regtest's 0 / 6 / 0, voted YES by seats 1 and 2, activated; GET /config and the rounds again
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { regtest } from './regtest-bond.mjs';
import { openStore, nodeIdentity } from '../src/store.js';
import { bondSetFor } from '../src/curve.js';
import { NEXTBLOCK, TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { encodeGameConfigV3 } from '../../nextblock/config/game-config.js';
import { RUN_82_TICKS } from './round-2of2.mjs';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_KEYS_REGTEST as KEYS } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { encodeRoundContract, decodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { deriveCensus } from '../../arena-protocol/src/census.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { encodeConfigProposalBody, proposalBodyId, CLASS } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected, BALLOT_GENESIS } from '../../arena-protocol/src/ballot-chain.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const env = process.env;
const B = env.BITCOIN_BIN, WORK = env.WORK;
if (!B || !WORK) throw new Error('BITCOIN_BIN=<bin dir> WORK=<dir>');
const RPC = Number(env.RPCPORT || 29411), P2P = RPC + 1;
const PORTS = [0, 1, 2].map((i) => Number(env.SEAT_PORT || 29421) + 10 * i);
const BONDS = [50000000n, 30000000n, 20000000n];
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 19), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const b32 = (n) => new Uint8Array(32).fill(n);
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const short = (h) => String(h).slice(0, 16);
mkdirSync(join(WORK, 'btc'), { recursive: true });

// ---- bitcoind, a wallet, coins
const bitcoind = spawn(`${B}/bitcoind`, ['-regtest', `-datadir=${WORK}/btc`, `-rpcport=${RPC}`, `-port=${P2P}`, '-listen=0', '-fallbackfee=0.0002', '-txindex=1'], { stdio: 'ignore' });
const cli = (...a) => execFileSync(`${B}/bitcoin-cli`, ['-regtest', `-datadir=${WORK}/btc`, `-rpcport=${RPC}`, ...a], { encoding: 'utf8' }).trim();
for (let n = 0; n < 60; n++) { try { cli('getblockcount'); break; } catch { await wait(500); } }
const wcli = (...a) => cli(...(a[0] === 'listwallets' || a[0] === 'createwallet' || a[0] === 'loadwallet' ? a : ['-rpcwallet=gov', ...a]));
const rt = regtest(wcli, { wallet: 'gov', network: 'regtest' });
rt.mine(250);
const tip = () => rt.height();
const mineOne = () => { rt.mine(1); return tip(); };
say({ step: 'bitcoind', rpc: RPC, height: tip() });

// ---- three seats
const stores = PORTS.map((_, i) => join(WORK, `node-${i + 1}.db`));
const ids = stores.map((p) => { const db = openStore(p); const id = nodeIdentity(db); db.close(); return id; });
const procs = PORTS.map((port, i) => {
  const e = { ...env, ARENA_BITCOIND_URL: `http://127.0.0.1:${RPC}`, ARENA_BITCOIND_COOKIE: `${WORK}/btc/regtest/.cookie`, ARENA_FUND_FREE_ROUNDS: '1',
    ARENA_GAMES: new URL('../../nextblock/plugin/nextblock.js', import.meta.url).pathname, ARENA_DONATION_NETWORK: 'regtest',
    ARENA_REGTEST_DONATION_SET: 'keys', ARENA_LOWEST_BOND_MIN_SATS: '100000', ARENA_BALLOT_EVERY_MS: '500' };
  delete e.ARENA_SERIES_FILE;
  const p = spawn(process.execPath, ['src/main.js', String(port), stores[i]], { cwd: new URL('..', import.meta.url).pathname, env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const s of [p.stdout, p.stderr]) s.on('data', (d) => appendFileSync(join(WORK, `node-${i + 1}.log`), d));
  return p;
});
const http = (i, path, init) => fetch(`http://127.0.0.1:${PORTS[i]}${path}`, init);
for (let i = 0; i < 3; i++) { for (let n = 0; n < 80; n++) { try { if ((await http(i, '/identity')).ok) break; } catch { /* not yet */ } await wait(500); } }
say({ step: 'seats', ports: PORTS, pids: procs.map((p) => p.pid), keys: ids.map((id) => short(toHex(id.pubkey))) });
const stopAll = async () => { for (const p of procs) { try { p.kill('SIGTERM'); } catch { /* gone */ } } await wait(1500); try { cli('stop'); } catch { bitcoind.kill('SIGTERM'); } await wait(1500); };
process.on('uncaughtException', async (e) => { console.error(e); await stopAll(); process.exit(1); });

try {
  // ---- their bonds
  const bondFrom = tip();
  const posted = ids.map((id, i) => { const p = rt.postBond(id.secret, { endpoint: `ws://127.0.0.1:${PORTS[i]}`, hostedGames: [NEXTBLOCK.gameId], bondSats: BONDS[i] }); rt.include([p.hex]); return p; });
  rt.mine(110);
  say({ step: 'bonds', sats: BONDS, height: tip(), txids: posted.map((p) => short(p.txid)) });

  // ---- the operator tokens each seat wrote at its first start (its pairing URI, scopes read, vote, config)
  const tokens = stores.map((s) => readFileSync(`${s}.operator-pairing`, 'utf8').trim().split('#')[1]);

  // ---- rounds: a free nextblock round at a census height, its census root derived as the seats derive it
  const nodes = [...ids.map((id) => id.pubkey)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const base = { networkId: NETWORK_ID_REGTEST, censusConfirmations: 1, gameVerifySlots: 3, settlementSlots: 3, gameId: NEXTBLOCK.gameId,
    simCoreHash: TRUCK_CORE_HASH, randomnessRule: 'bitcoin-block-hash', objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
    slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, donationSetId: donationSetId(KEYS.recipients), censusRoot: b32(0),
    stakeMsat: 0n, bondMinSats: 50000n, blockTicks: RUN_82_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30,
    timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes };
  let tag = 0;
  const roundAt = (configHash, censusHeight) => {
    const now = BigInt(Date.now());
    const c = decodeRoundContract(encodeRoundContract({ ...base, configHash, censusHeight, committeeTimeMs: now + 20000n, startTimeMs: now + 320000n,
      entryCloseMs: now + 320000n, publicationRelays: [`wss://r.example/${tag++}`] }));
    const view = rt.blocksFrom(bondFrom, censusHeight);
    const byTxid = new Map();
    for (const block of view.blocks) for (const raw of block.transactions || []) { try { byTxid.set(toHex(parseTransaction(raw).txid), raw); } catch { /* not one */ } }
    const census = deriveCensus(view, { contract: c, bond: bondSetFor('regtest'), verifyUpdate: verify,
      resolve: (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; } });
    if (!census.ok) throw new Error(`no census at ${censusHeight}: ${census.why}`);
    return { ...c, censusRoot: census.root };
  };
  // ONCE MORE ON A CONNECTION ERROR (measured on the first run: a keep-alive socket the seat had closed during the bonds' 10 s
  // answered "fetch failed" for the first round at two seats; nothing reached them)
  const postOnce = (i, c) => http(i, '/round', { method: 'POST', body: encodeRoundContract(c) })
    .then(async (r) => ({ status: r.status, said: (await r.text()).slice(0, 220) }), (e) => ({ status: `error ${e.message}`, said: '' }));
  const postRound = async (c) => Promise.all(PORTS.map(async (_, i) => {
    let r = await postOnce(i, c);
    if (String(r.status).startsWith('error')) { await wait(1000); r = await postOnce(i, c); }
    return r;
  }));
  const roundLine = async (label, c) => { const got = await postRound(c); say({ step: 'round', label, round: short(toHex(roundId(c))), config: short(toHex(c.configHash)), censusHeight: c.censusHeight,
    status: got.map((g) => g.status), said: got[0].status >= 300 || typeof got[0].status !== 'number' ? got[0].said : undefined }); return got; };

  const V4 = BALLOT_GENESIS.configHash, V3 = TRUCK_V3_CONFIG_HASH;
  const beforeHeight = tip();
  const before = roundAt(V4, beforeHeight);
  await roundLine('1 created before any proposal, genesis config', before);

  // ---- a deposit to the keyed set, and a proposal on it
  const depositTo = (sats) => {
    const want = depositOutputsExpected(sats, KEYS.recipients);
    if (!want.ok) throw new Error(want.why);
    const outputs = {};
    for (const o of want.outputs) outputs[JSON.parse(cli('decodescript', toHex(o.script))).address] = Number(o.sats) / 1e8;
    const txid = JSON.parse(wcli('-named', 'send', `outputs=${JSON.stringify(outputs)}`, 'fee_rate=2')).txid;
    const height = mineOne();
    const raw = fromHex(JSON.parse(wcli('gettransaction', txid)).hex);
    return { txid, height, blockHash: cli('getblockhash', String(height)), raw, outputs: want.outputs.map((o) => Number(o.sats)) };
  };
  const propose = async (label, { parent, configHash, config, activationAfter }) => {
    const dep = depositTo(1000);
    const p = { networkId: NETWORK_ID_REGTEST, parent, configHash, config, class: CLASS.DESIGN, activationHeight: dep.height + activationAfter,
      proposer: ids[0].pubkey, depositTxid: Uint8Array.from(parseTransaction(dep.raw).txid) };
    const hex = toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), ids[0].secret)]));
    const answers = [];
    for (let i = 0; i < 3; i++) {
      const r = await http(i, '/proposal', { method: 'POST', body: JSON.stringify({ proposal: hex, blockHash: dep.blockHash }) });
      answers.push({ status: r.status, body: await r.json() });
    }
    const a = answers[0].body;
    say({ step: 'proposal', label, depositTxid: short(dep.txid), depositOutputs: dep.outputs, publishedAt: dep.height, status: answers.map((x) => x.status),
      id: a.id, class: a.class, repeal: a.repeal, votingFrom: a.votingFrom, votingUntil: a.votingUntil, activationHeight: a.activationHeight, why: a.why });
    return { id: a.id, at: dep.height, answers };
  };
  // ---- a vote: the seat's operator door signs it with the bond key, this wallet sends the OP_RETURN
  const castVote = async (i, id, choice) => {
    const r = await http(i, '/operator/vote', { method: 'POST', headers: { authorization: `Bearer ${tokens[i]}` }, body: JSON.stringify({ proposalId: id, choice }) });
    const v = await r.json();
    if (!v.ok) throw new Error(`seat ${i + 1} vote: ${v.why}`);
    const raw = wcli('createrawtransaction', '[]', JSON.stringify([{ data: v.opReturn }]));
    const funded = JSON.parse(wcli('fundrawtransaction', raw, JSON.stringify({ fee_rate: 2 }))).hex;
    const txid = wcli('sendrawtransaction', JSON.parse(wcli('signrawtransactionwithwallet', funded)).hex);
    return { seat: i + 1, choice, txid: short(txid), payloadBytes: v.opReturn.length / 2 };
  };
  const proposalsAt = async (i) => (await (await http(i, '/proposals')).json());
  const configAt = async (i) => (await (await http(i, '/config')).json());
  /** Until every seat's pass has seen the tip (the count runs every 500 ms). */
  const settle = async () => { const want = tip(); for (let n = 0; n < 40; n++) { const t = await Promise.all([0, 1, 2].map(async (i) => (await proposalsAt(i)).tip)); if (t.every((x) => x === want)) return; await wait(250); } };
  const tallyLine = async (label, id) => {
    await settle();
    const rows = await Promise.all([0, 1, 2].map(async (i) => (await proposalsAt(i)).proposals.find((p) => p.id === id)));
    const t = rows[0].tally || {};
    say({ step: 'tally', label, tip: tip(), phase: rows.map((r) => r.phase), yesSats: t.yesSats, noSats: t.noSats, abstainSats: t.abstainSats, totalSats: t.totalSats,
      turnoutPct: t.turnoutPct, approvalPct: t.approvalPct, passed: t.passed, running: !!t.running, decidedAt: t.decidedAt, sameAtEverySeat: rows.every((r) => JSON.stringify(r.tally) === JSON.stringify(rows[0].tally)) });
  };
  const configLine = async (label) => {
    await settle();
    const got = await Promise.all([0, 1, 2].map(configAt));
    say({ step: 'GET /config', label, tip: tip(), configHash: got.map((g) => short(g.configHash)), since: got[0].since, by: got[0].by && short(got[0].by),
      history: got[0].history.map((h) => `${h.configHash.slice(0, 8)}@${h.since}`) });
    return got[0];
  };

  const t0 = Date.now();
  await configLine('before');
  const design = await propose('2 DESIGN 2170f250 -> f51759b6', { parent: V4, configHash: V3, config: encodeGameConfigV3(), activationAfter: 8 });
  const P = design.at;
  // block P+1, the first of the voting phase: seat 1 NO
  const v1 = [await castVote(0, design.id, 'NO')]; mineOne();
  // block P+2: seat 1 YES (its last vote wins), seat 2 ABSTAIN
  const v2 = [await castVote(0, design.id, 'YES'), await castVote(1, design.id, 'ABSTAIN')]; mineOne();
  say({ step: 'votes', blocks: { [P + 1]: v1, [P + 2]: v2 } });
  await tallyLine('during voting', design.id);
  while (tip() < P + 6) mineOne();                                            // the last voting block (votingUntil P+7)
  await tallyLine('voting over (last voting block mined)', design.id);
  const late = await castVote(2, design.id, 'YES'); mineOne();               // P+7: after the phase
  say({ step: 'votes', blocks: { [P + 7]: [late] }, note: 'after the voting phase: not counted' });
  await tallyLine('cooldown', design.id);
  await configLine('cooldown, not live yet');
  mineOne();                                                                  // P+8: activation
  const live1 = await configLine('activation');
  await tallyLine('activated', design.id);
  say({ step: 'cycle', seconds: Math.round((Date.now() - t0) / 100) / 10, from: 'first GET /config to activation' });

  // ---- the rounds under it
  await roundLine('2 created after the activation, the new hash', roundAt(V3, live1.since));
  await roundLine('3 created after the activation, the old hash', roundAt(V4, live1.since));
  await roundLine('1 again (created before, the old hash): kept', before);
  await roundLine('4 created before the activation, the new hash', roundAt(V3, beforeHeight));

  // ---- the repeal, and a forward proposal on its short schedule
  const t1 = Date.now();
  await propose('5a forward on the short schedule (0 / 6 / 0)', { parent: V3, configHash: b32(0x6f), config: Uint8Array.of(7), activationAfter: 6 });
  const repeal = await propose('5b repeal f51759b6 -> 2170f250 (genesis bytes)', { parent: V3, configHash: V4, config: BALLOT_GENESIS.config, activationAfter: 6 });
  const Q = repeal.at;
  const r1 = [await castVote(0, repeal.id, 'YES'), await castVote(1, repeal.id, 'YES')]; mineOne();
  say({ step: 'votes', blocks: { [Q + 1]: r1 } });
  while (tip() < Q + 5) mineOne();
  await tallyLine('repeal: voting over', repeal.id);
  mineOne();                                                                  // Q+6: activation
  const live2 = await configLine('repeal activated');
  await tallyLine('repeal activated', repeal.id);
  say({ step: 'cycle', seconds: Math.round((Date.now() - t1) / 100) / 10, from: 'repeal deposit to its activation' });
  await roundLine('6 created after the repeal, the genesis hash', roundAt(V4, live2.since));
  await roundLine('7 created after the repeal, f51759b6', roundAt(V3, live2.since));
  await roundLine('8 created at the first activation height (f51759b6 live there), posted after the repeal', roundAt(V3, live1.since));
  // what each seat logged of the count
  for (let i = 0; i < 3; i++) say({ step: `seat ${i + 1} log`, ballot: (readFileSync(join(WORK, `node-${i + 1}.log`), 'utf8').match(/\[ballot\][^\n]*/g) || []).slice(-4) });
} finally {
  await stopAll();
  say({ step: 'stopped', work: WORK, seats: procs.map((p) => p.pid), bitcoind: bitcoind.pid });
}
process.exit(0);
