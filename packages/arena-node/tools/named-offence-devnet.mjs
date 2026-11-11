#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NAMED CLAIM'S OFFENCES, FILED AND SLASHED ON SEVEN REAL SEATS (§5A.3 rows (a), (b), protocol 27, kanban #1044 B1 phase 4). Regtest only, on a devnet that slashes
// (DEVNET_SLASH=1 ARENA_PROTOCOL_VERSION=27 DEVNET_KEEPER=0 devnet.mjs up, then its liquidity step). A paid round of two entries, played by tools/tn4-live-run.mjs,
// and five seats armed with the regtest test fault (test-named-offence.js, census/offence-<n>.txt) - the first five of the round's settlement seats in seat order:
//
//   SCENARIO=off-table     (a) the five sign a claim paying OFF_TABLE_KEY in place of the largest payout; the honest seats file it, census key 0's holders start the slash
//   SCENARIO=forfeit-lost  (b) both players ask for their stake lock's forfeit at once (EARLY_FORFEIT); the five sign it for the entry they signed lost, before the settlement
//   SCENARIO=honest        nothing armed: the gate - no seat files anything
//   SCENARIO=stock         a round below ARENA_TEST_NAMED_CLAIM_HEIGHT (the devnet started with it): stock LNv2 locks, settled as before
//   SCENARIO=swap-refund   (a) by a swapped refund key (ruling #1135 2): the five sign a claim whose first gateway send refunds to OFF_TABLE_KEY, not KeyAgg(S)
//   SCENARIO=send-refund   a failed send (ruling #1134 2): every seat armed `send-hold`, so no gateway is asked and no seat submits (c); after the send's
//                          expiration an outside client (no seat, its own data dir) submits (c) - first before the expiration and with the qualifier key
//                          swapped to OFF_TABLE_KEY, both refused - and the winner takes the refund's payout into its wallet
//   SCENARIO=nobody-won    nothing armed, both players lose (LOSE=1): nobody won, every stake comes back by its forfeit (nobodyWonReturn) - and no seat may file
//                          that as offence (b) (kanban #1044, measured 2026-11-05 on s28a round b94a4863: five honest bonds started)
//   SCENARIO=donation-resend  ruling #1145 A (#1134 2's donation residual): a loser (LOSE) and a walk-away (NO_MARKS), nobody qualifying, so the walk-away's
//                          lock is split 75% to the seats and 25% to the donation set by gateway sends (with a winner it goes to the winner: s29a round 578b9f87); the set's two LNURL recipients (127.0.0.1:18777, the signed regtest set - the devnet started with
//                          DEVNET_DONATION_SET=lnurl) answer their first invoice with a hold invoice cancelled at once, so that send fails; this tool mines to
//                          its expiration, the contract refunds to KeyAgg(S) and S re-sends it through the other gateway to a fresh invoice
//   SCENARIO=stall3        nothing armed (kanban #1044 hole 1): three of the round's seats (the contract's last three) are stopped (SIGSTOP) once both
//                          entries are published; the four left reach FINAL and cannot settle (5 of 7); after STALL_HOLD_S the loser takes its locks back
//                          at their expiration (REFUND_AFTER_PLAY), then the three come back (SIGCONT) and the settlement is watched (ruling #1146 A: F')
//                          WINNER_REFUND=1 (kanban #1044, 4 silent): the winner too takes its locks back at their expiration (REFUND_AFTER_PLAY) -
//                          with four of seven settlement seats silent no settlement can be signed, so the winner's stake must come back as the loser's does
//   SCENARIO=stop-s        nothing armed: a member of S is stopped (SIGSTOP) as soon as a seat keeps the signed batch; the sends must still be paid
//
// The three last name a Lightning address for both players (PAYOUT_ADDRESS): an https LNURL door on base + 9 answering with lnd C's invoices, its
// certificate ADDRESS_CERT_DIR/cert.pem - the seats must have been started trusting it (NODE_EXTRA_CA_CERTS, h27.sh).
//
// Every state read is printed with its time from the round's end, once per change; at the end the filed proofs (GET /slashes namedSlashes) and the slash starts
// (GET /slash-releases) of every seat. Settings as tools/devnet.mjs (DEVNET_DIR, DEVNET_BASE_PORT), PAYER_DIR, INVITE_FILE, WASM_PKG and LNCLI as tn4-live-run.mjs takes.
import { spawn, spawnSync } from 'node:child_process';
import { createServer as httpsServer } from 'node:https';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
// THE HONEST SEATS STEP OUT OF THE SIGNING (off-table): an honest asker's session over the honest body and a faulty asker's over the off-table one take each
// other's partials as bad and drop each other until no signer set is left (measured 2026-11-05, round e868dfb6: "no signer set is left"). So the two honest
// seats' node processes (their guardians keep running) are stopped STOP_AFTER_S after the round's end - every result signed, before the window closes -
// and sent SIGCONT once an armed seat holds the settlement accepted, or at the limit. They then read the claim like any seat that never acked
import { readFileSync, writeFileSync, openSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devnetPorts } from './devnet-plan.mjs';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { OFF_TABLE_KEY } from '../src/test-named-offence.js';
import { serveDonationRecipients } from '../src/lnurl-recipients.js';
import { randomBytes } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const D = resolve(env.DEVNET_DIR || 'devnet-data');
const PLAN = devnetPorts(Number(env.DEVNET_BASE_PORT || 24000));
const SEATS = PLAN.nodes.map((p) => `http://127.0.0.1:${p}`);
const SCENARIO = env.SCENARIO || 'honest';
const LIMIT = Number(env.LIMIT_S || 1500);
const SCENARIOS = ['off-table', 'forfeit-lost', 'honest', 'stock', 'swap-refund', 'send-refund', 'stop-s', 'nobody-won', 'donation-resend', 'stall3'];
if (!SCENARIOS.includes(SCENARIO)) { console.error(`SCENARIO is ${SCENARIOS.join(', ')}`); process.exit(2); }
// THE CLAIM SIGNED OFF THE CORRECT BODY BY FIVE ARMED SEATS, the honest ones stopped through the signing: (a) by a payout (off-table) or by a send's refund key
const OFF = SCENARIO === 'off-table' || SCENARIO === 'swap-refund';
const ADDRESSED = ['swap-refund', 'send-refund', 'stop-s'].includes(SCENARIO);
const say = (o) => console.log(`#1044 ${JSON.stringify({ at: new Date().toISOString().slice(11, 19), ...o })}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (url, ms = 6000) => fetch(url, { signal: AbortSignal.timeout(ms) });
const offenceFile = (k) => join(D, 'census', `offence-${k + 1}.txt`);
const pidOf = (k) => JSON.parse(readFileSync(join(D, 'pids', `node-${k + 1}.pid`), 'utf8')).pid;
const stopped = new Set();
const backIn = (k) => { if (!stopped.has(k)) return; try { process.kill(pidOf(k), 'SIGCONT'); } catch { /* gone */ } stopped.delete(k); say({ step: 'seat back', seat: k + 1, t: at() }); };
for (let k = 0; k < SEATS.length; k++) writeFileSync(offenceFile(k), '');

for (const stop = Date.now() + 600000; Date.now() < stop; await wait(5000)) {
  const named = await Promise.all(SEATS.map(async (s) => { try { const f = (await (await get(`${s}/reserves`)).json()).federations; return !!(f && f[0] && (f[0].key || f[0].reserveKey)); } catch { return false; } }));
  if (named.filter(Boolean).length === SEATS.length) break;
}
// THE WINNERS' LIGHTNING ADDRESS (ADDRESSED scenarios): https on base + 9 with ADDRESS_CERT_DIR's certificate, LUD-16 then LUD-06 with lnd C's invoices
let ADDRESS = null;
if (ADDRESSED) {
  const certDir = env.ADDRESS_CERT_DIR || join(D, 'address-cert');
  const port = PLAN.base + 9;
  const metadata = JSON.stringify([['text/plain', 'a Bitcoin Arena winning (devnet #1044)']]);
  const descriptionHash = createHash('sha256').update(metadata).digest('hex');
  const lnc = (...a) => spawnSync(env.LNCLI, [`--lnddir=${join(D, 'lnd-c')}`, `--rpcserver=127.0.0.1:${PLAN.lnd.c.rpc}`, '--network=regtest', ...a], { encoding: 'utf8', timeout: 30000 });
  const door = httpsServer({ key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) }, (req, res) => {
    const u = new URL(req.url, 'https://127.0.0.1');
    const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/.well-known/lnurlp/winner') return json(200, { tag: 'payRequest', callback: `https://127.0.0.1:${port}/cb`, metadata, minSendable: 1000, maxSendable: 10000000000 });
    if (u.pathname !== '/cb') return json(404, { status: 'ERROR', reason: 'no such door' });
    const r = lnc('addinvoice', `--amt_msat=${u.searchParams.get('amount')}`, `--description_hash=${descriptionHash}`, '--expiry=3600');
    if (r.status !== 0) return json(500, { status: 'ERROR', reason: String(r.stderr).trim().slice(-160) });
    say({ step: 'address invoice', msat: u.searchParams.get('amount'), hash: JSON.parse(r.stdout).r_hash.slice(0, 16) });
    return json(200, { pr: JSON.parse(r.stdout).payment_request, routes: [] });
  });
  await new Promise((ok) => door.listen(port, '127.0.0.1', ok));
  door.unref();
  ADDRESS = `winner@127.0.0.1:${port}`;
}
// THE DONATION RECIPIENTS (donation-resend): each one's first invoice a hold invoice cancelled as soon as it is issued - a send to it fails - then plain invoices
let recipients = null;
const lncC = (...a) => spawnSync(env.LNCLI, [`--lnddir=${join(D, 'lnd-c')}`, `--rpcserver=127.0.0.1:${PLAN.lnd.c.rpc}`, '--network=regtest', ...a], { encoding: 'utf8', timeout: 30000 });
const lncA = (...a) => spawnSync(env.LNCLI, [`--lnddir=${join(D, 'lnd-a')}`, `--rpcserver=127.0.0.1:${PLAN.lnd.a.rpc}`, '--network=regtest', ...a], { encoding: 'utf8', timeout: 30000 });
if (SCENARIO === 'donation-resend') {
  // THE OTHER GATEWAY REACHES THE RECIPIENTS (measured on s29f round 99e27117): the re-send goes through gateway B, whose lnd B reaches lnd C only through
  // lnd A, and a gateway pays with no routing budget beyond its own fee (the invoice is sized to it) - "FailureReasonNoRoute", lnd A asking 1015 msat.
  // So lnd A forwards for nothing here, set before the round: its policy is gossiped to lnd B by the time of the re-send
  const pol = lncA('updatechanpolicy', '--base_fee_msat=0', '--fee_rate_ppm=0', '--time_lock_delta=80');
  say({ step: 'lnd A forwards free', ok: pol.status === 0, said: String(pol.status === 0 ? pol.stdout : pol.stderr).replace(/\s+/g, ' ').slice(0, 160) });
  const failed = new Set();
  // EVERY ASK OF THE DOOR IS SAID (measured on s29b round 764e3ecb: both shares held as "did not answer" and this tool printed no invoice at all)
  const paths = new Map();
  let conns = 0;
  setInterval(() => { say({ step: 'recipient asks', asks: Object.fromEntries(paths), connections: conns, listening: !!recipients }); paths.clear(); conns = 0; }, 60000).unref();
  recipients = await serveDonationRecipients({ onConnect: () => { conns += 1; }, onAsk: (m, p) => paths.set(`${m} ${p}`, (paths.get(`${m} ${p}`) || 0) + 1), invoice: async ({ amountMsat, descriptionHash }) => {
    const dh = toHex(descriptionHash);
    if (!failed.has(dh)) {
      failed.add(dh);
      const hash = toHex(randomBytes(32));
      const r = lncC('addholdinvoice', hash, `--amt_msat=${amountMsat}`, `--description_hash=${dh}`, '--expiry=3600');
      if (r.status !== 0) throw new Error(String(r.stderr).trim().slice(-160));
      const c = lncC('cancelinvoice', hash);
      say({ step: 'recipient invoice that fails', msat: String(amountMsat), hash: hash.slice(0, 16), cancelled: c.status === 0 });
      return { request: JSON.parse(r.stdout).payment_request };
    }
    const r = lncC('addinvoice', `--amt_msat=${amountMsat}`, `--description_hash=${dh}`, '--expiry=3600');
    if (r.status !== 0) throw new Error(String(r.stderr).trim().slice(-160));
    say({ step: 'recipient invoice', msat: String(amountMsat), hash: JSON.parse(r.stdout).r_hash.slice(0, 16) });
    return { request: JSON.parse(r.stdout).payment_request };
  } });
}
if (recipients) { try { const r = await fetch(`${recipients.base}/lnurlp/blwp-test-a`); say({ step: 'recipients door', base: recipients.base, selfProbe: r.status }); } catch (e) { say({ step: 'recipients door', selfProbe: e.message }); } }
const opened = await (await fetch(`http://127.0.0.1:${PLAN.control}/open-paid?stakeMsat=${env.STAKE_MSAT || 100000000}&windowMs=${env.WINDOW_MS || 420000}`, { method: 'POST' })).json();
if (!opened.id) throw new Error(`no round opened: ${JSON.stringify(opened)}`);
const ROUND = opened.id;
const contract = decodeRoundContract(new Uint8Array(await (await get(`${SEATS[0]}/round?id=${ROUND}`)).arrayBuffer()));
const END = Number(windowsOf(contract).openMs);
const at = () => Math.round((Date.now() - END) / 1000);
const height = async () => { try { return (await (await get(`${SEATS[0]}/chain-tip`)).json()).height; } catch { return null; } };
// THE SEAT ORDER: the contract's nodes, each one's devnet node by its /identity
const ids = await Promise.all(SEATS.map(async (s) => toHex(new Uint8Array(await (await get(`${s}/identity`)).arrayBuffer()))));
const order = contract.nodes.map((k) => ids.indexOf(toHex(k)));
// ARMED_N (default 6): the claim is signed by the threshold (5), but with only 5 seats up one failed session of a body leaves no signer set at all
// (measured 2026-11-05, round a8e68cb6: two armed askers at once, each seat's pair spent on the first list it saw); a sixth gives the signing its slack
const armed = order.slice(0, Number(env.ARMED_N || 6));
say({ step: 'round', scenario: SCENARIO, round: ROUND, version: contract.protocolVersion, censusHeight: contract.censusHeight, end: new Date(END).toISOString(),
  seatOrder: order.map((k) => k + 1), armed: OFF || SCENARIO === 'forfeit-lost' ? armed.map((k) => k + 1) : SCENARIO === 'send-refund' ? SEATS.map((_, k) => k + 1) : [] });
if (OFF) for (const k of armed) writeFileSync(offenceFile(k), `${SCENARIO} ${ROUND}\n`);
// A FAILED SEND: no seat asks a gateway or submits (c) for this round
if (SCENARIO === 'send-refund') for (let k = 0; k < SEATS.length; k++) writeFileSync(offenceFile(k), `send-hold ${ROUND}\n`);

// THE FEDERATION'S HEIGHT CATCHES UP FIRST (measured 2026-11-05 on s27b/s27c: an opening mines its blocks at once, the guardians' consensus height trailed the
// chain by 15 and every seat refused the locks made then as "more than 12 blocks below the height it is verified at")
await wait(Number(env.WAIT_AFTER_OPEN_S || 90) * 1000);
const keysFile = join(D, `keys-${SCENARIO}-${ROUND.slice(0, 8)}.jsonl`);
const goFile = join(D, `refund-go-${ROUND.slice(0, 8)}`);
const players = [0, 1].map((i) => {
  const log = join(D, `player-${SCENARIO}-${ROUND.slice(0, 8)}-${i}.log`);
  const fd = openSync(log, 'a');
  const child = spawn(process.execPath, [join(HERE, 'tn4-live-run.mjs')], { detached: true, stdio: ['ignore', fd, fd],
    env: { ...env, ARENA_TN4_NETWORK: 'regtest', ARENA_REGTEST_CENSUS_KEY_0: join(D, 'census', 'key0.json'), ROUND, PORTS: PLAN.nodes.join(','), KEYS_FILE: keysFile, COLLECT_MS: String(env.COLLECT_MS || 900000),
      ...(SCENARIO === 'nobody-won' ? { LOSE: '1', FORFEIT_RETRY_S: env.FORFEIT_RETRY_S || '600' } : SCENARIO === 'donation-resend' ? (i === 1 ? { NO_MARKS: '1' } : { LOSE: '1' }) : i === 0 ? { SEARCH: '1', QUALIFY: '1', ...(SCENARIO === 'stall3' && env.WINNER_REFUND === '1' ? { REFUND_AFTER_PLAY: '1', REFUND_GO_FILE: goFile } : {}) } : SCENARIO === 'forfeit-lost' ? { LOSE: '1' } : SCENARIO === 'stall3' ? { LOSE: '1', REFUND_AFTER_PLAY: '1', REFUND_GO_FILE: goFile } : {}), ...(SCENARIO === 'forfeit-lost' ? { EARLY_FORFEIT: '1' } : {}),
      ...(ADDRESS ? { PAYOUT_ADDRESS: ADDRESS } : {}), ...(SCENARIO === 'send-refund' ? { REFUND_C: '1' } : {}) } });
  return { i, log, child };
});
const lines = (p) => { try { return readFileSync(p.log, 'utf8').split('\n'); } catch { return []; } };
const said = (p, step) => lines(p).filter((l) => l.includes(`"step":"${step}"`));
const entries = () => { const out = []; try { for (const l of readFileSync(keysFile, 'utf8').trim().split('\n')) { const x = JSON.parse(l); if (x.round === ROUND && x.entry && !out.includes(x.entry)) out.push(x.entry); } } catch { /* not yet */ } return out; };
for (const stop = END - 15000; Date.now() < stop && !players.every((p) => said(p, 'published').length); await wait(2000));
const E = entries();
for (const p of players) say({ step: 'player', i: p.i, published: said(p, 'published').length > 0, handed: (said(p, 'handed over')[0] || '').slice(0, 160) });
if (!E.length) throw new Error('no entry was played');
if (SCENARIO === 'forfeit-lost') for (const k of armed) writeFileSync(offenceFile(k), E.map((e) => `forfeit-lost ${e}`).join('\n') + '\n');
say({ step: 'entries', entries: E, armedLines: SCENARIO === 'forfeit-lost' ? E.length : OFF ? 1 : 0 });
// THREE SETTLEMENT SEATS SILENT (stall3): the contract's last three nodes' seat processes stopped; their guardians keep running
// STALL_N (kanban #1281, the fallback claim): how many of the last seats are silent - 3 (the four left file the fallback at lock + stall_blocks), 4 (three
// cannot: the locks refund at their expiration). FALLBACK_END=1 ends the watch once a live seat holds the round's settlement ACCEPTED.
const STALL = SCENARIO === 'stall3' ? order.slice(-Number(env.STALL_N || 3)) : [];
// STALL_AT=signed: the three are stopped only once every seat holds each entry's signed result (PROVISIONALLY_FINAL, the window running), so the
// result goes FINAL on the four left and only the settlement (5 of 7) is missing - §23 hole 1 as written. Otherwise at once, before any result is signed
const finalityAt = async (k) => Promise.all(E.map(async (e) => { try { return await (await get(`${SEATS[k]}/settlement?entry=${e}`, 20000)).json(); } catch (x) { return { error: x.message }; } }));
// STALL_BY=hold (the default): the three are armed `settle-hold <round>` (test-named-offence.js) - silent in this round's settlement only, their results,
// guardians and every other door as before. STALL_BY=stop: their seat processes SIGSTOPped - and with them the guardian door the clients use
// (ws://<seat>/guardian), so a client reaches 4 of 7 guardians and cannot even join (measured on s47a try 1)
const BY_STOP = env.STALL_BY === 'stop';
let stallOn = false;
const stopStall = async (why) => {
  if (BY_STOP) for (const k of STALL) { process.kill(pidOf(k), 'SIGSTOP'); stopped.add(k); }
  else for (const k of STALL) writeFileSync(offenceFile(k), `settle-hold ${ROUND}\n`);
  stallOn = true;
  say({ step: `${STALL.length} seats stopped`, by: BY_STOP ? 'SIGSTOP' : 'settle-hold', why, seats: STALL.map((k) => k + 1), height: await height() });
};
const releaseStall = () => {
  if (BY_STOP) for (const k of [...stopped]) backIn(k);
  else for (const k of STALL) { writeFileSync(offenceFile(k), ''); say({ step: 'seat back', seat: k + 1, by: 'settle-hold cleared', t: at() }); }
  stallOn = false;
};
if (STALL.length && env.STALL_AT !== 'signed') await stopStall('both entries published');
let stallGo = null, resumedAt = null;

// THE OUTSIDER (send-refund): the stake-lock tool on a client of its own that no seat runs - joined here - submitting the presigned refund (c)
const LOCK_BIN = join(env.FEDIMINT_BIN || '', 'arena-stake-lock');
const OUT_DIR = join(D, 'clients', 'outsider');
const tool = (args) => { const r = spawnSync(LOCK_BIN, args, { encoding: 'utf8', timeout: 180000 }); const line = String(r.stdout).trim().split('\n').filter((l) => l.startsWith('{')).pop();
  try { return line ? JSON.parse(line) : { error: String(r.stderr).trim().split('\n').pop() }; } catch { return { error: String(r.stdout).slice(0, 200) }; } };
const bcli = (...a) => spawnSync(join(env.BITCOIN_BIN || '', 'bitcoin-cli'), ['-regtest', `-datadir=${join(D, 'btc')}`, `-rpcport=${PLAN.rpc}`, ...a], { encoding: 'utf8', timeout: 60000 });
let outsider = null;
async function outsiderSubmits() {
  outsider = { step: 'started' };
  if (!existsSync(join(OUT_DIR, 'client.db'))) { mkdirSync(OUT_DIR, { recursive: true }); say({ step: 'outsider join', said: JSON.stringify(tool(['--mode', 'join', '--data-dir', OUT_DIR, '--invite', readFileSync(join(D, 'invite-code'), 'utf8').trim()])).slice(0, 200) }); }
  let c = null, j = null;
  for (let tries = 0; tries < 60 && !c; tries++) {
    for (const s of SEATS) { try { j = await (await get(`${s}/send-refunds?round=${ROUND}`)).json(); c = (j.refunds || [])[0] || null; } catch { c = null; } if (c) break; }
    if (!c) await wait(10000);
  }
  if (!c) { outsider = { step: 'no refund (c) at any seat' }; say({ step: 'outsider', ...outsider }); return; }
  say({ step: 'refund (c) read', settlementTxid: j.settlementTxid, signers: j.signers, refundKey: j.refundKey, refund: c });
  const submit = (qualifierPk) => tool(['--mode', 'arena-send-refund', '--data-dir', OUT_DIR, '--send', c.send, '--amount-msat', c.amountMsat, '--refund-pk', c.refundPk,
    '--qualifier-pk', qualifierPk, '--signature', c.signature]);
  const status = () => tool(['--mode', 'status', '--data-dir', OUT_DIR, '--outpoint', c.send]);
  const st0 = status();
  say({ step: 'send contract', status: st0 });
  const early = submit(c.qualifierPk);
  say({ step: 'refund (c) before the expiration', accepted: early.accepted === true, error: String(early.error || '').slice(0, 200), txid: early.txid });
  const left = st0.stored ? Number(st0.stored.blocks_left) : 0;
  if (left > 0) { bcli('generatetoaddress', String(left + 2), 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080'); say({ step: 'mined', blocks: left + 2, height: Number(bcli('getblockcount').stdout) }); }
  let st = status();
  for (let tries = 0; tries < 60 && st.stored && Number(st.stored.blocks_left) > 0; tries++) { await wait(10000); st = status(); }
  say({ step: 'send contract after mining', status: st });
  const swapped = submit(toHex(OFF_TABLE_KEY));
  say({ step: 'refund (c) with the qualifier key swapped', accepted: swapped.accepted === true, verifies: swapped.signature_verifies, error: String(swapped.error || '').slice(0, 200), txid: swapped.txid });
  const real = submit(c.qualifierPk);
  outsider = { step: 'done', accepted: real.accepted === true, txid: real.txid, payoutMsat: real.payout_msat, error: real.error || null, height: Number(bcli('getblockcount').stdout) };
  say({ step: 'refund (c) by the outsider', ...outsider });
}
// A MEMBER OF S STOPPED RIGHT AFTER THE BATCH (stop-s): the highest seat of S, as soon as any seat answers its kept batch
let sStopped = null;
let mined = null;
const SHORT_OF = Number(env.SHORT_OF || 6);

const honestSeats = SEATS.map((_, k) => k).filter((k) => !armed.includes(k));
const stopAt = END + Number(env.STOP_AFTER_S || 60) * 1000;
process.on('exit', () => { for (const k of [...stopped]) { try { process.kill(pidOf(k), 'SIGCONT'); } catch { /* gone */ } } });
// A RUN STOPPED FROM OUTSIDE (SIGTERM, tools wrapping a retry): its stopped seats come back and its players end, as at a normal end
process.on('SIGTERM', () => { for (const p of players) { try { process.kill(-p.child.pid, 'SIGTERM'); } catch { /* it ended */ } } process.exit(143); });
const last = new Map();
const seen = (key, value) => { if (last.get(key) === value) return; last.set(key, value); say({ t: at(), [key]: value }); };
let filedAt = null;
for (;;) {
  if (OFF && !stopped.size && !last.get('honest stopped') && Date.now() >= stopAt) {
    for (const k of honestSeats) { process.kill(pidOf(k), 'SIGSTOP'); stopped.add(k); }
    last.set('honest stopped', true);
    say({ step: 'honest seats stopped', seats: honestSeats.map((k) => k + 1), t: at() });
  }
  if (SCENARIO === 'stop-s' && !sStopped) {
    for (const s of SEATS) {
      let j = null; try { const r = await get(`${s}/send-refunds?round=${ROUND}`); j = r.ok ? await r.json() : null; } catch { j = null; }
      if (!j || !Array.isArray(j.signers)) continue;
      const member = Math.max(...j.signers), k = order[member];
      process.kill(pidOf(k), 'SIGSTOP'); stopped.add(k);
      sStopped = { seat: k + 1, member, signers: j.signers, settlementTxid: j.settlementTxid, from: s, t: at() };
      say({ step: 'member of S stopped', ...sStopped });
      break;
    }
  }
  // THE DONATION SENDS (donation-resend), as the seats keep them, and the mining to a failed send's expiration
  if (SCENARIO === 'donation-resend') {
    for (let k = 0; k < SEATS.length; k++) {
      const q = spawnSync('/usr/bin/sqlite3', [join(D, 'nodes', `node-${k + 1}.db`), `SELECT lower(hex(entry_id)), attempt, state, gateway_url, expiration, txid, out_idx, coalesce(preimage,''), substr(why,1,90) FROM donation_sends WHERE lower(hex(round_id)) = '${ROUND}' ORDER BY entry_id, attempt`], { encoding: 'utf8', timeout: 10000 });
      seen(`seat${k + 1} donation sends`, String(q.stdout).trim().split('\n').filter(Boolean).map((l) => { const x = l.split('|'); return `${x[0].slice(0, 8)}#${x[1]} ${x[2]} gw${x[3].slice(-5)} exp${x[4]} ${String(x[5]).slice(0, 16)}:${x[6]}${x[7] ? ' preimage' : ''} ${x[8]}`; }).join(' ; ') || 'none');
    }
    const rows = [...last.entries()].filter(([key]) => key.endsWith('donation sends')).map(([, v]) => v).join(' ; ');
    const exp = [...rows.matchAll(/#0 SENDING gw\S* exp(\d+)/g)].map((m) => Number(m[1]));
    const h = Number(bcli('getblockcount').stdout);
    // MINED TO JUST SHORT OF THE EXPIRATION, THE BLOCK CLOCK DOING THE REST (measured on s29f round 99e27117: mined past it in one go, 1,389 blocks, a seat
    // named the re-send's expiration over its gateway list kept from before the mining - 60 s - so it was 1860 at a tip of 1828 and the gateway answered
    // "TimeoutTooClose"). SHORT_OF (default 6) blocks of the clock give every seat's kept list time to read the federation's height after the jump
    if (exp.length && !mined && h < Math.max(...exp) - SHORT_OF) { const n = Math.max(...exp) - SHORT_OF - h; bcli('generatetoaddress', String(n), 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080'); mined = { from: h, to: h + n, expiration: Math.max(...exp), t: at() }; say({ step: 'mined to just short of the failed send\'s expiration', ...mined }); }
  }
  if (SCENARIO === 'stall3') {
    if (env.STALL_AT === 'signed' && !stallOn && !stallGo) {
      const all = []; for (let k = 0; k < SEATS.length; k++) all.push(await finalityAt(k));
      const states = all.map((f) => f.map((x) => x.finality || x.error || null));
      seen('finality', JSON.stringify(states));
      const closes = Math.min(...all.flat().map((x) => Number(x.windowClosesAtMs || Infinity)));
      if (states.every((f) => f.every((x) => x === 'PROVISIONALLY_FINAL' || x === 'FINAL'))) {
        const ls = await (await get(`${SEATS[0]}/lock-settlement?round=${ROUND}`)).json().catch(() => ({}));
        await stopStall(`every seat holds both results signed; window closes ${Number.isFinite(closes) ? new Date(closes).toISOString() : '?'}; seat 1 settlement ${ls.state}`);
      }
    }
    if (!stallGo && at() >= Number(env.STALL_HOLD_S || 900)) {
      const live = [];
      for (let k = 0; k < SEATS.length; k++) {
        if (stopped.has(k)) continue;
        let r = null, l = null;
        try { const x = await get(`${SEATS[k]}/results?round=${ROUND}`, 20000); r = `${x.status} ${(await x.text()).slice(0, 400)}`; } catch (e) { r = e.message; }
        try { l = await (await get(`${SEATS[k]}/lock-settlement?round=${ROUND}`, 20000)).json(); } catch (e) { l = { error: e.message }; }
        live.push({ seat: k + 1, results: r, settlement: l, finality: (await finalityAt(k)).map((x) => `${x.finality || x.error}${x.finalityWhy ? ` (${String(x.finalityWhy).slice(0, 120)})` : ''}`) });
      }
      stallGo = { t: at(), height: await height(), live };
      say({ step: 'stall watched', ...stallGo });
      writeFileSync(goFile, `${new Date().toISOString()}\n`);
    }
    const refunded = said(players[1], 'refunded');
    if (refunded.length && stallOn && !resumedAt) {
      await wait(Number(env.RESUME_AFTER_S || 60) * 1000);
      say({ step: 'loser refunded, seats come back', height: await height(), refunded: refunded[0].slice(0, 600) });
      releaseStall();
      resumedAt = Date.now();
    }
    if (resumedAt && Date.now() - resumedAt > Number(env.RESUME_WATCH_S || 1800) * 1000) break;
  }
  if (SCENARIO === 'stall3' && env.FALLBACK_END === '1' && [...last.entries()].some(([key, v]) => key.endsWith(' settlement') && /^ACCEPTED/.test(v || ''))) {
    say({ step: 'settled while seats were silent', height: await height(), states: [...last.entries()].filter(([key]) => key.endsWith(' settlement')) });
    break;
  }
  if (SCENARIO === 'send-refund' && !outsider && [...last.entries()].some(([key, v]) => key.endsWith(' settlement') && /^ACCEPTED/.test(v || ''))) await outsiderSubmits();
  if (ADDRESSED) for (const [i, e] of E.entries()) {
    try { const w = await (await get(`${SEATS[SEATS.findIndex((_, k) => !stopped.has(k))]}/winnings?entry=${e}`)).json(); seen(`entry${i} send`, w.send ? `${w.send.state} ${String(w.send.why || '').slice(0, 120)}${w.send.preimage ? ' preimage' : ''}` : 'none'); } catch { /* next pass */ }
  }
  if (OFF && stopped.size && (armed.some((k) => /^ACCEPTED/.test(last.get(`seat${k + 1} settlement`) || '')) || at() >= LIMIT - 300)) for (const k of [...stopped]) backIn(k);
  for (let k = 0; k < SEATS.length; k++) {
    if (stopped.has(k)) continue;
    try { const l = await (await get(`${SEATS[k]}/lock-settlement?round=${ROUND}`)).json(); seen(`seat${k + 1} settlement`, `${l.state || l.why || 'none'}${l.txid ? ` ${String(l.txid).slice(0, 16)}` : ''}`.slice(0, 200)); } catch { /* next pass */ }
    try {
      const s = await (await get(`${SEATS[k]}/slashes`)).json();
      const mine = (s.namedSlashes || []).filter((r) => r.round === ROUND);
      seen(`seat${k + 1} filed`, mine.map((r) => `row${r.row}:${r.node.slice(0, 8)}:${r.proof.slice(0, 12)}`).sort().join(' ') || 'none');
      if (mine.length && filedAt === null) filedAt = Date.now();
    } catch { /* next pass */ }
    try { const r = await (await get(`${SEATS[k]}/slash-releases`)).json(); seen(`seat${k + 1} starts`, JSON.stringify((r.starts || []).map((x) => ({ s: x.state || x.status, txid: String(x.startTxid || x.txid || '').slice(0, 16), bond: String(x.bond || x.outpoint || '').slice(0, 20) }))).slice(0, 400)); } catch { /* not a holder */ }
  }
  for (const p of players) for (const step of ['early forfeit', 'collected', 'stopped', 'settled', 'no early forfeit: the settlement came first', 'refund go', 'refunded', 'waiting for expiry']) if (said(p, step).length) seen(`player${p.i} ${step}`, said(p, step)[0].slice(0, 400));
  if (at() >= LIMIT) break;
  if (filedAt && Date.now() - filedAt > Number(env.AFTER_FILED_S || 600) * 1000) break;
  // EVERY RECIPIENT'S SHARE PAID BY A RE-SEND at some seat - not only the first one paid
  const everyResent = (v) => { const rows = String(v || '').split(' ; ').filter((r) => /^[0-9a-f]{8}#/.test(r)); const ents = new Set(rows.map((r) => r.slice(0, 8)));
    return ents.size > 0 && [...ents].every((e) => rows.some((r) => r.startsWith(e) && /^[0-9a-f]{8}#[1-9]\d* PAID/.test(r))); };
  if (SCENARIO === 'donation-resend' && [...last.entries()].some(([key, v]) => key.endsWith('donation sends') && everyResent(v)) && at() > 300) break;
  if (SCENARIO === 'honest' || SCENARIO === 'stock' || SCENARIO === 'stop-s' || SCENARIO === 'send-refund' || SCENARIO === 'nobody-won') {
    if (players.every((p) => p.child.exitCode !== null || said(p, 'collected').length) && at() > 300 && (SCENARIO !== 'send-refund' || (outsider && outsider.step !== 'started'))
      && (SCENARIO !== 'stop-s' || /^PAID/.test(last.get('entry0 send') || '') || at() > 1200)
      // NOBODY WON: the filers' passes after the stakes came back, every one of them (ARENA_NAMED_FILE_MS), are what is measured
      && (SCENARIO !== 'nobody-won' || at() >= Number(env.QUIET_S || 1300))) break;
  }
  await wait(10000);
}
// AT THE END: every seat's proofs of this round, and every slash start, whole
for (let k = 0; k < SEATS.length; k++) {
  try {
    const s = await (await get(`${SEATS[k]}/slashes`, 20000)).json();
    const r = await (await get(`${SEATS[k]}/slash-releases`, 20000)).json().catch(() => ({ starts: [] }));
    const ls = await (await get(`${SEATS[k]}/lock-settlement?round=${ROUND}`, 20000)).json().catch((e) => ({ error: e.message }));
    say({ step: 'end', seat: k + 1, named: (s.namedSlashes || []).filter((x) => x.round === ROUND), starts: r.starts || [], settlement: ls });
  } catch (e) { say({ step: 'end', seat: k + 1, noAnswer: e.message }); }
}
for (let k = 0; k < SEATS.length; k++) writeFileSync(offenceFile(k), '');
for (const k of [...stopped]) backIn(k);
for (const p of players) { try { process.kill(-p.child.pid, 'SIGTERM'); } catch { /* it ended */ } }
say({ step: 'done', scenario: SCENARIO, round: ROUND, t: at(), height: await height() });
// THE DONATION RECIPIENTS' DOOR IS CLOSED HERE, AFTER THE WATCH (kanban #1044): measured on s29b-s29e, it was closed inside the watch loop's first pass,
// before the round ended - every seat's ask of 18777 was refused, and both shares were held "the recipient did not answer" with the door never asked
if (recipients) await recipients.close();
process.exit(0);
