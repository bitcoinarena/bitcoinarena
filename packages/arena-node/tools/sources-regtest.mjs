// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NEW MARKET SOURCE THROUGH THE VOTE, ON A PRIVATE REGTEST (kanban #921): three seats bonded 50 / 30 / 20 M sat, each with an owner and the bond wallet.
//   1  the owner's door refuses an example that does not answer, and a host already listed
//   2  the host is not readable yet; the deposit from the bond wallet, the proposal once it confirmed, every seat keeps it with what it read
//   3  YES refused while the example does not answer; seats 1 and 2 vote from their owners' doors, seat 3 abstains
//   4  at activation every seat lists the host with its example, and an owner's market test reads it
// BITCOIN_BIN=<bin dir> WORK=<dir> node tools/sources-regtest.mjs
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { regtest } from './regtest-bond.mjs';
import { openStore, nodeIdentity } from '../src/store.js';
import { ownerSecretFromSeed, signOwnerRequest } from '../src/owner.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';

const env = process.env;
const B = env.BITCOIN_BIN, WORK = env.WORK;
if (!B || !WORK) throw new Error('BITCOIN_BIN=<bin dir> WORK=<dir>');
const RPC = Number(env.RPCPORT || 29511), P2P = RPC + 1;
const PORTS = [0, 1, 2].map((i) => Number(env.SEAT_PORT || 29521) + 10 * i);
const BONDS = [50000000n, 30000000n, 20000000n];
const HOST = 'ws.kraken.com';
const INIT = `// Kraken sends the ticker once it is asked
function init(message, step) {
  if (step > 0) return null;
  return JSON.stringify({ method: 'subscribe', params: { channel: 'ticker', symbol: ['BTC/USD'] } });
}
`;
const ENTRY = { host: HOST, url: `wss://${HOST}/v2`, read: 'text', path: '', docs: 'https://docs.kraken.com/api/docs/websocket-v2/ticker', init: INIT };
const BAD_INIT = "function init(message, step) {\n  return eval('1');\n}\n";
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 19), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(join(WORK, 'btc'), { recursive: true });

const bitcoind = spawn(`${B}/bitcoind`, ['-regtest', `-datadir=${WORK}/btc`, `-rpcport=${RPC}`, `-port=${P2P}`, '-listen=0', '-fallbackfee=0.0002', '-txindex=1'], { stdio: 'ignore' });
const base = ['-regtest', `-datadir=${WORK}/btc`, `-rpcport=${RPC}`];
const cli = (...a) => execFileSync(`${B}/bitcoin-cli`, [...base, ...a], { encoding: 'utf8' }).trim();
for (let n = 0; n < 60; n++) { try { cli('getblockcount'); break; } catch { await wait(500); } }
const wcli = (...a) => cli(...(['listwallets', 'createwallet', 'loadwallet'].includes(a[0]) ? a : ['-rpcwallet=gov', ...a]));
const rt = regtest(wcli, { wallet: 'gov', network: 'regtest' });
rt.mine(250);
const tip = () => rt.height();
const mineOne = () => { rt.mine(1); return tip(); };

const stores = PORTS.map((_, i) => join(WORK, `node-${i + 1}.db`));
const ids = stores.map((p) => { const db = openStore(p); const id = nodeIdentity(db); db.close(); return id; });
const routes = PORTS.map((p) => `http://127.0.0.1:${p}`).join(',');
const procs = PORTS.map((port, i) => {
  const e = { ...env, ARENA_BITCOIND_URL: `http://127.0.0.1:${RPC}`, ARENA_BITCOIND_COOKIE: `${WORK}/btc/regtest/.cookie`, ARENA_DONATION_NETWORK: 'regtest', ARENA_FUND_FREE_ROUNDS: '1', ARENA_GAMES: new URL('../../nextblock/plugin/nextblock.js', import.meta.url).pathname,
    ARENA_REGTEST_DONATION_SET: 'keys', ARENA_LOWEST_BOND_MIN_SATS: env.LOWEST_BOND || '100000', ARENA_BALLOT_EVERY_MS: '500', ARENA_PEERS: routes,
    ARENA_BOND_CLI: [`${B}/bitcoin-cli`, ...base, '-rpcwallet=gov'].join(',') };
  delete e.ARENA_SERIES_FILE;
  const p = spawn(process.execPath, ['src/main.js', String(port), stores[i]], { cwd: new URL('..', import.meta.url).pathname, env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const s of [p.stdout, p.stderr]) s.on('data', (d) => appendFileSync(join(WORK, `node-${i + 1}.log`), d));
  return p;
});
const http = (i, path, init) => fetch(`http://127.0.0.1:${PORTS[i]}${path}`, init);
for (let i = 0; i < 3; i++) { for (let n = 0; n < 80; n++) { try { if ((await http(i, '/identity')).ok) break; } catch { /* not yet */ } await wait(500); } }
const stopAll = async () => { for (const p of procs) { try { p.kill('SIGTERM'); } catch { /* gone */ } } await wait(1500); try { cli('stop'); } catch { bitcoind.kill('SIGTERM'); } };
process.on('uncaughtException', async (e) => { console.error(e); await stopAll(); process.exit(1); });

const secrets = [1, 2, 3].map((n) => ownerSecretFromSeed(new Uint8Array(32).fill(n)));
const nodes = await Promise.all([0, 1, 2].map(async (i) => (await (await http(i, '/owner')).json()).node));
const signed = (i, action, args) => signOwnerRequest({ node: nodes[i], action, args, secret: secrets[i], sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
const door = async (i, path, action, args) => { const r = await http(i, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signed(i, action, args)) }); return { status: r.status, ...(await r.json()) }; };
const settle = () => wait(2500);
const sources = () => Promise.all([0, 1, 2].map(async (i) => (await http(i, '/market-sources')).json()));
const proposalOf = async (i, id) => (await (await http(i, '/proposals')).json()).proposals.find((p) => p.id === id);

try {
  for (let i = 0; i < 3; i++) say({ step: 'claim', seat: i + 1, ...(await door(i, '/owner/claim', 'claim', { code: readFileSync(`${stores[i]}.owner-claim`, 'utf8').trim() })) });
  ids.forEach((id, i) => { const p = rt.postBond(id.secret, { endpoint: `ws://127.0.0.1:${PORTS[i]}`, hostedGames: [NEXTBLOCK.gameId], bondSats: BONDS[i] }); rt.include([p.hex]); });
  rt.mine(7);
  await settle();
  say({ step: 'bonds', sats: BONDS, height: tip(), hosts: (await sources()).map((s) => s.hosts.length) });

  // 1
  say({ step: '1 no answer', ...(await door(0, '/owner/source-proposal', 'source-proposal', { entry: { ...ENTRY, host: 'api.frankfurter.dev', url: 'https://api.frankfurter.dev/nothing-here', init: '' } })) });
  say({ step: '1 malicious init', ...(await door(0, '/owner/source-proposal', 'source-proposal', { entry: { ...ENTRY, init: BAD_INIT } })) });
  say({ step: '1 listed', ...(await door(0, '/owner/source-proposal', 'source-proposal', { entry: { ...ENTRY, host: 'api.coinbase.com', url: 'https://api.coinbase.com/v2/time', init: '' } })) });
  say({ step: '1 no docs', ...(await door(0, '/owner/source-proposal', 'source-proposal', { entry: { ...ENTRY, docs: '' } })) });
  // 2
  const before = await door(0, '/owner/market-test', 'market-test', { reads: [{ id: 'page', kind: 'ws', url: ENTRY.url }] });
  say({ step: '2 before', ok: before.ok, why: before.why });
  const paid = await door(0, '/owner/source-proposal', 'source-proposal', { entry: ENTRY });
  say({ step: '2 deposit', ...paid });
  say({ step: '2 unconfirmed', ...(await door(0, '/owner/source-proposal', 'source-proposal', { entry: ENTRY, txid: paid.txid })) });
  const at = mineOne();
  await settle();
  const pub = await door(0, '/owner/source-proposal', 'source-proposal', { entry: ENTRY, txid: paid.txid });
  say({ step: '2 published', at, ...pub });
  const kept = await Promise.all([0, 1, 2].map((i) => proposalOf(i, pub.id)));
  say({ step: '2 kept', seats: kept.map((p) => (p ? { phase: p.phase, example: p.example, added: p.added.map((e) => e.host) } : null)) });
  // 3
  while (tip() < pub.votingFrom) mineOne();
  await settle();
  const votes = [await door(0, '/owner/source-vote', 'source-vote', { proposalId: pub.id, choice: 'YES' }), await door(1, '/owner/source-vote', 'source-vote', { proposalId: pub.id, choice: 'YES' }),
    await door(2, '/owner/source-vote', 'source-vote', { proposalId: pub.id, choice: 'ABSTAIN' })];
  say({ step: '3 votes', votes: votes.map((v) => ({ status: v.status, sent: v.sent, why: v.why })) });
  while (tip() < pub.votingUntil) mineOne();
  mineOne();
  await settle();
  const counted = await Promise.all([0, 1, 2].map((i) => proposalOf(i, pub.id)));
  say({ step: '3 counted', tip: tip(), seats: counted.map((p) => ({ phase: p.phase, passed: p.tally && p.tally.passed, turnout: p.tally && p.tally.turnoutPct, yes: p.tally && p.tally.yesSats, abstain: p.tally && p.tally.abstainSats, total: p.tally && p.tally.totalSats })) });
  // 4
  while (tip() < pub.activationHeight) mineOne();
  mineOne();
  await settle();
  const after = await sources();
  say({ step: '4 live', tip: tip(), since: after.map((s) => s.since), listed: after.map((s) => s.hosts.includes(HOST)), hash: after.map((s) => String(s.configHash).slice(0, 12)), init: after.map((s) => !!(s.entries.find((e) => e.host === HOST) || {}).init) });
  const read = await door(1, '/owner/market-test', 'market-test', { reads: [{ id: 'page', kind: 'ws', url: ENTRY.url }] });
  say({ step: '4 read, the voted init started it', ok: read.ok, why: read.why, messages: read.reads && read.reads.page.length, last: read.reads && JSON.stringify(read.reads.page[read.reads.page.length - 1]).slice(0, 120) });
} finally {
  await stopAll();
  say({ step: 'stopped', work: WORK });
}
process.exit(0);
