#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PROPOSAL PAID FROM THE PROTOCOL RESERVES, END TO END ON A DEVNET (kanban #397, spec §27A.9.3). Regtest only: nothing on testnet4 or
// mainnet, no bond anywhere but the devnet's own chain, and no rule of the reserves is touched: the seats decide and pay as they always do.
//
//   ARENA_PROTOCOL_VERSION=11 ARENA_FUNDING_SCHEDULE=short ARENA_BOND_SLACK_BLOCKS=800 DEVNET_KEEPER=0 DEVNET_BLOCK_SECONDS=0 \
//     node tools/devnet.mjs up && node tools/devnet.mjs liquidity && node tools/devnet-payout.mjs
//
// THE DEVNET MUST BE STARTED THAT WAY: version 11 so an entry pays the reserves; the short schedule (a week is 108 blocks); a bond lock past
// the vote, or no bond votes; no keeper and no block clock, because this tool mines to exact heights. The same DEVNET_DIR and DEVNET_BASE_PORT.
//
//   a paid entry    tools/tn4-live-run.mjs, the page's wasm lock client, paid over lnd B through gateway A: 2 % of the stake reaches the reserve key
//   served weeks    three free rounds, `devnet.mjs play` each, a week apart, every one to its FINAL signatures (ten minutes of objection window each)
//   the proposal    signed by seat 1, naming the devnet's LNURL door; a signal from every seat at its publication height
//   the vote        each seat's own operator door builds its vote, this wallet publishes it
//   the payout      the seats' own funding loop: 5-of-7 under the reserve key, an outgoing contract, a gateway, lnd C's invoice
//
// One JSON line per reading. What it has done is kept in DEVNET_DIR/payout.json, so a run that stopped goes on where it stopped: the three rounds
// take about 45 minutes. AMOUNT_SATS (default 20) is the proposal: rule 5 pays more than 1 % of the reserves in tranches and rule 4 no more than 10 % at all, and
// one entry at PAID_STAKE_MSAT (default 100 000 000) leaves 2 000 sat in the reserves, so 20 sat is one payment.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1.js';
import { devnetPorts, firstRoundHeight, nextRoundHeight, signalHeights, weekOf } from './devnet-plan.mjs';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { roundEndMs } from '../../arena-protocol/src/first-mark.js';
import { OBJECTION_WINDOW_MS, FINAL_TOLERANCE_MS } from '../../arena-protocol/src/constants.js';
import { splitSignedFinalSig, decodeFinalSig } from '../../arena-protocol/src/final-sig.js';
import { FUNDING_SCHEDULES, encodeFundingProposal, fundingProposalId, encodeFundingSignal, fundingSignalId } from '../../arena-protocol/src/funding.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { lnurlFor } from '../../arena-protocol/src/bech32.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const D = resolve(env.DEVNET_DIR || 'devnet-data');
const PLAN = devnetPorts(Number(env.DEVNET_BASE_PORT || 24000));
const S = FUNDING_SCHEDULES.short, W = S.week;
const AMOUNT_SATS = BigInt(env.AMOUNT_SATS || 20);
const PAID_STAKE_MSAT = String(env.PAID_STAKE_MSAT || 100000000);
const SEATS = PLAN.nodes.length;
const URLS = PLAN.nodes.map((p) => `http://127.0.0.1:${p}`);
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 19), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (h) => String(h).slice(0, 16);
const need = (v, name) => { if (!v) throw new Error(`${name} is not set`); return v; };

const BTC = need(env.BITCOIN_BIN, 'BITCOIN_BIN'), LND = need(env.LND_BIN, 'LND_BIN');
const btc = (...a) => execFileSync(join(BTC, 'bitcoin-cli'), ['-regtest', `-datadir=${join(D, 'btc')}`, `-rpcport=${PLAN.rpc}`, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 }).trim();
const wallet = (...a) => btc('-rpcwallet=devnet', ...a);
const lnc = (...a) => JSON.parse(execFileSync(join(LND, 'lncli'), [`--lnddir=${join(D, 'lnd-c')}`, `--rpcserver=127.0.0.1:${PLAN.lnd.c.rpc}`, '--network=regtest', ...a], { encoding: 'utf8' }));
const tip = () => Number(btc('getblockcount'));
const mine = (n) => { let left = n; while (left > 0) { const k = Math.min(left, 100); wallet('generatetoaddress', String(k), wallet('getnewaddress')); left -= k; } };
const mineTo = (h) => { if (tip() < h) mine(h - tip()); };
const mtpMs = (h) => Number(JSON.parse(btc('getblockheader', btc('getblockhash', String(h)))).mediantime) * 1000;

const NOTE = join(D, 'payout.json');
const note = existsSync(NOTE) ? JSON.parse(readFileSync(NOTE, 'utf8')) : { rounds: [] };
const keep = () => writeFileSync(NOTE, JSON.stringify(note, null, 1) + '\n');

const http = async (i, path, init) => { try { return await fetch(`${URLS[i]}${path}`, init); } catch { await wait(1000); return fetch(`${URLS[i]}${path}`, init); } };
const getJson = async (i, path) => (await http(i, path)).json();
const control = async (path) => {
  const r = await fetch(`http://127.0.0.1:${PLAN.control}${path}`, { method: 'POST', signal: AbortSignal.timeout(600000) });
  const got = await r.json();
  if (!r.ok) throw new Error(`the runner opened no round: ${got.why}`);
  return got;
};
const contractOf = async (id) => decodeRoundContract(new Uint8Array(await (await http(0, `/round?id=${id}`)).arrayBuffer()));

/** A child tool's output as JSON lines, each said on as it comes; answers the lines and the exit code. */
const run = (args, extra = {}) => new Promise((ok) => {
  const p = spawn(process.execPath, args, { cwd: resolve(HERE, '..'), env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'inherit'] });
  const lines = []; let rest = '';
  p.stdout.on('data', (d) => {
    rest += d;
    for (let at = rest.indexOf('\n'); at >= 0; at = rest.indexOf('\n')) {
      const line = rest.slice(0, at); rest = rest.slice(at + 1);
      try { const o = JSON.parse(line); lines.push(o); if (o.step) say({ tool: args[0].split('/').pop(), step: o.step, ...(o.why ? { why: String(o.why).slice(0, 300) } : {}) }); } catch { /* not a reading */ }
    }
  });
  p.on('close', (code) => ok({ code, lines }));
});

const heldMsat = async () => { const r = await getJson(0, '/reserves'); return BigInt(r.federations[0].heldMsat); };

// ---- THE RESERVES HOLD MONEY: a paid entry, as a player pays one ----
async function paidEntry() {
  if (await heldMsat() >= AMOUNT_SATS * 100000n) return;
  // every seat names the key: the entry asks them, and each answers a kept /reserves for up to a minute after its key was made
  for (let i = 0; i < 90; i++) { const said = await Promise.all(URLS.map((_, n) => getJson(n, '/reserves').catch(() => null))); if (said.every((r) => r && r.federations[0] && r.federations[0].key)) break; await wait(5000); }
  // a short entry window, so the round closes and settles inside the run tool's wait for it
  const round = await control(`/open-paid?stakeMsat=${PAID_STAKE_MSAT}&windowMs=60000`);
  say({ step: 'paid round', id: short(round.id), start: round.start });
  const got = await run([join(HERE, 'tn4-live-run.mjs')], { ARENA_TN4_NETWORK: 'regtest', PORTS: PLAN.nodes.join(','), INVITE_FILE: join(D, 'invite-code'), ROUND: round.id,
    WASM_PKG: env.WASM_PKG || resolve(HERE, '..', '..', 'arena-client', 'dist'), LNCLI: join(LND, 'lncli'), PAYER_DIR: join(D, 'lnd-b'), PAYER_RPC: `127.0.0.1:${PLAN.lnd.b.rpc}`,
    GATEWAY: `http://localhost:${PLAN.gateway.a.api}`, ANCHOR_HASH: btc('getblockhash', '0'), ANCHOR_HEIGHT: '0' });
  if (got.code !== 0) say({ step: 'paid entry', stopped: JSON.stringify(got.lines[got.lines.length - 1] || {}).slice(0, 300) });
}

// ---- A SERVED ROUND: played, then its FINAL signatures read back from the seats ----
async function servedRound(k) {
  const t0 = Date.now();
  // the wall clock past the tip's median time: every FINAL then comes after the median time of every block below
  for (;;) { const lead = mtpMs(tip()) - Date.now(); if (lead < -2000) break; await wait(Math.min(lead + 2500, 30000)); }
  const got = await run([join(HERE, 'devnet.mjs'), 'play']);
  const round = got.lines.find((l) => l.step === 'round'), signed = got.lines.find((l) => l.step === 'signed result');
  if (got.code !== 0 || !round || !signed || !signed.final) throw new Error(`round ${k} was not played to a signed result: ${JSON.stringify(got.lines[got.lines.length - 1] || {}).slice(0, 400)}`);
  const c = await contractOf(round.id);
  const finalAfter = Number(roundEndMs(c)) + Number(OBJECTION_WINDOW_MS) + Number(FINAL_TOLERANCE_MS);
  let finals = [];
  for (const until = finalAfter + 8 * 60000; Date.now() < until;) {
    await wait(Math.max(5000, Math.min(60000, finalAfter - Date.now())));
    if (Date.now() < finalAfter) continue;
    const all = await Promise.all(URLS.map((_, i) => getJson(i, `/served?from=${Number(c.committeeTimeMs)}&to=${Date.now() + 60000}&finals=1`).catch(() => null)));
    const bySigner = new Map();
    for (const g of all) for (const r of (g && g.held) || []) if (r.roundId === round.id) for (const f of r.finals) {
      const x = decodeFinalSig(splitSignedFinalSig(fromHex(f)).body);
      bySigner.set(toHex(x.signerPubkey), Number(x.signedAtMs));
    }
    finals = [...bySigner.values()];
    if (finals.length >= SEATS || (finals.length >= receiptsNeeded(SEATS) && Date.now() > finalAfter + 60000)) break;
  }
  say({ step: 'FINAL', k, round: short(round.id), signers: finals.length, tip: tip(), minutes: Math.round((Date.now() - t0) / 6000) / 10 });
  if (finals.length < receiptsNeeded(SEATS)) throw new Error(`round ${k} reached no FINAL`);
  // the next blocks come after the FINALs on the chain's clock
  const last = Math.max(...finals);
  if (Date.now() < last + 1500) await wait(last + 1500 - Date.now());
}

// ---- THE SEATS' KEYS: each store read-only, as the runner reads them for the first bonds ----
const stores = PLAN.nodes.map((_, k) => join(D, 'nodes', `node-${k + 1}.db`));
const secretOf = (store) => { const db = new DatabaseSync(store, { readOnly: true }); try { return new Uint8Array(db.prepare('SELECT secret FROM identity WHERE one = 0').get().secret); } finally { db.close(); } };

const postFunding = (kind, hex) => Promise.all(URLS.map(async (_, i) => {
  const r = await http(i, '/funding', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, hex }) });
  const t = await r.text(); let body; try { body = JSON.parse(t); } catch { body = { why: t.slice(0, 200) }; }
  return { status: r.status, why: body.why };
}));

async function proposeAndSignal(P) {
  const secrets = stores.map(secretOf);
  const url = `http://127.0.0.1:${PLAN.lnurl}/.well-known/lnurlp/payee`;
  const p = { networkId: NETWORK_ID_REGTEST, author: schnorr.getPublicKey(secrets[0]), publishedHeight: P, amountSats: AMOUNT_SATS, lnurl: lnurlFor(url), purpose: 'a devnet payout from the protocol reserves' };
  const pid = fundingProposalId(p);
  const a = await postFunding('proposal', toHex(Uint8Array.from([...encodeFundingProposal(p), ...schnorr.sign(pid, secrets[0])])));
  say({ step: 'proposal', id: toHex(pid), publishedHeight: P, tip: tip(), amountSats: AMOUNT_SATS, lnurl: p.lnurl, status: a.map((x) => x.status), why: a.find((x) => x.status >= 300)?.why });
  for (const secret of secrets) {
    const s = { proposalId: pid, node: schnorr.getPublicKey(secret), atHeight: P };
    const got = await postFunding('signal', toHex(Uint8Array.from([...encodeFundingSignal(s), ...schnorr.sign(fundingSignalId(s), secret)])));
    if (got.some((x) => x.status >= 300)) say({ step: 'signal refused', node: short(toHex(s.node)), said: got.find((x) => x.status >= 300) });
  }
  return toHex(pid);
}

const proposalAt = async (i, id) => ((await getJson(i, '/funding')).proposals || []).find((x) => x.id === id);

async function main() {
  const state = JSON.parse(readFileSync(join(D, 'runner', 'state.json'), 'utf8'));
  if (state.status !== 'up') throw new Error(`the devnet's runner says ${state.status}`);
  const funding = await getJson(0, '/funding');
  say({ step: 'devnet', tip: tip(), seats: SEATS, federation: short(state.federationId), schedule: funding.schedule ?? null, heldMsat: await heldMsat() });

  await paidEntry();
  const held = await heldMsat();
  say({ step: 'reserves', heldMsat: held, asks: AMOUNT_SATS * 1000n });
  if (held < AMOUNT_SATS * 100000n) throw new Error(`the reserves hold ${held} msat, and a proposal of ${AMOUNT_SATS} sat goes out as one payment from ${AMOUNT_SATS * 100000n}`);

  // ---- three rounds, each mined up to a week after the last one's FINAL (devnet-plan.mjs): each FINAL's week, once the signal's end is known ----
  for (let k = note.rounds.length; k < 3; k++) {
    if (k) mineTo(nextRoundHeight(note.rounds[k - 1].tip, S));
    else mineTo(firstRoundHeight({ tip: tip(), lastBond: Number((await contractOf(state.rounds[0].id)).censusHeight), schedule: S }));
    await servedRound(k);
    note.rounds.push({ k, tip: tip() }); keep();
  }
  const { E, P } = signalHeights(note.rounds[2].tip, S);
  say({ step: 'heights', finalsBehind: note.rounds.map((r) => r.tip), weeks: note.rounds.map((r) => weekOf(r.tip, E, S)), publishedAt: P, signalEnd: E, tip: tip() });
  if (!note.proposal) {
    mineTo(P - 1);
    note.proposal = await proposeAndSignal(P); keep();
  }
  const id = note.proposal;
  mineTo(E);

  // ---- the signal decided: each seat's funding loop, every two minutes ----
  let open = null;
  for (let n = 0; n < 60 && !open; n++) {
    const views = await Promise.all(URLS.map((_, i) => proposalAt(i, id)));
    if (views.every((v) => v && v.signal && v.signal.state !== 'signalling' && v.vote && v.vote.censusHeight !== null)) { open = views[0]; say({ step: 'signal', signal: open.signal, vote: { from: open.vote.from, until: open.vote.until, censusHeight: open.vote.censusHeight } }); }
    else await wait(10000);
  }
  if (!open) throw new Error('the seats did not decide the signal');
  if (open.signal.state !== 'passed') throw new Error(`the signal did not pass: ${JSON.stringify(open.signal)}`);

  // ---- the bond-weighted vote: every seat YES, from its own operator door, published by this wallet ----
  if (!note.voted) {
    mineTo(open.vote.from);
    for (let i = 0; i < SEATS; i++) {
      const token = readFileSync(`${stores[i]}.operator-pairing`, 'utf8').trim().split('#')[1];
      const r = await (await http(i, '/operator/vote', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ proposalId: id, choice: 'YES' }) })).json();
      if (!r.ok) { say({ step: 'vote refused', seat: i + 1, why: r.why }); continue; }
      const txid = JSON.parse(wallet('-named', 'send', `outputs=${JSON.stringify([{ data: r.opReturn }])}`, 'fee_rate=2')).txid;
      say({ step: 'vote', seat: i + 1, choice: 'YES', txid: short(txid) });
    }
    mine(1);
    note.voted = true; keep();
  }
  mineTo(open.vote.until + S.decideDepth + 1);
  let seen = [];
  for (let n = 0; n < 40; n++) {
    seen = await Promise.all(URLS.map((_, i) => proposalAt(i, id)));
    if (seen.every((p) => p && p.vote && (p.vote.state === 'passed' || p.vote.state === 'failed'))) break;
    await wait(10000);
  }
  say({ step: 'vote counted', state: seen.map((p) => p && p.vote && p.vote.state), count: seen[0] && seen[0].vote && seen[0].vote.count, tip: tip() });

  // ---- the payout: the seats' own, each block read by their funding loop; a block every 20 s for the coordinator's turns and a tranche's height ----
  const before = lnc('channelbalance').local_balance?.sat ?? null;
  let row = null, last = '';
  for (const until = Date.now() + 40 * 60000; Date.now() < until;) {
    const views = await Promise.all(URLS.map((_, i) => getJson(i, '/reserves').catch(() => null)));
    // (one record per payment: a proposal's own id, or a tranche's when the reserves cover it in several; this devnet's reserves pay one proposal)
    const rows = views.map((v) => ((v && v.payouts) || [])[0] || null);
    row = rows.find((p) => p && p.state === 'PAID') || rows.find(Boolean) || null;
    const line = JSON.stringify(rows.map((p) => (p ? p.state : null)));
    if (line !== last) { say({ step: 'payout', states: rows.map((p) => (p ? p.state : null)), amountSats: row && row.amountSats, txid: row && row.txid && short(row.txid), why: row && row.why, tip: tip() }); last = line; }
    if (row && ['PAID', 'REFUNDED', 'SHORT'].includes(row.state)) break;
    mine(1);
    await wait(20000);
  }
  if (!row || row.state !== 'PAID') throw new Error(`no payout: ${JSON.stringify(row)}`);
  const invoices = lnc('listinvoices').invoices.filter((x) => x.state === 'SETTLED');
  const paid = invoices.find((x) => x.r_hash === row.paymentHash);
  say({ step: 'PAID', proposal: short(id), amountSats: row.amountSats, paymentHash: row.paymentHash, preimage: row.preimage, invoiceAtPayee: paid ? { state: paid.state, amtPaidSat: paid.amt_paid_sat } : null,
    payeeChannelSatBefore: before, payeeChannelSatAfter: lnc('channelbalance').local_balance?.sat ?? null, reservesHeldMsat: await heldMsat(), tip: tip() });
  if (!paid || BigInt(paid.amt_paid_sat) !== AMOUNT_SATS) throw new Error('the payee\'s lnd does not show the invoice paid');
}

main().catch((e) => { say({ step: 'stopped', why: String(e.message).slice(0, 500) }); process.exit(1); });
