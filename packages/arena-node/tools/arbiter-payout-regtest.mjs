#!/usr/bin/env node
/**
 * THE ARBITER'S PAYOUT STEP, END TO END ON A REGTEST CHAIN (kanban #307, §5A.3B) - the service's own code (arbiter.js
 * payOutSlash) on a slash it recorded: a players' escrow output funded from the stack's wallet as path B pays it (its txid
 * standing in for the posted slash), two wronged players with their shares; payOutSlash is called as the service's pass
 * calls it until it says paid - the escrow spent by k of the set into the federation, the peg-in claimed, each share locked
 * to refundKeyOf(the player's key) - then each player's key redeems its own payout in a fresh client of the federation.
 *
 *   BITCOIN_CLI="<bitcoin-cli> -datadir=<dir> -rpcwallet=<w>" STAKE_LOCK_BIN=<bin> CLIENT_DIR=<arbiter's client> FEDIMINT_CLI=<bin>
 *   INVITE_FILE=<file> WORK_DIR=<dir> [FORK_HOME=<home>] node tools/arbiter-payout-regtest.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js';
import { arbitrationMembers, payOutSlash } from '../src/arbiter.js';
import { escrowOutput } from '../../arena-protocol/src/arbitration-tx.js';
import { tweakPoint, combine } from '../src/curve.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const env = process.env;
for (const k of ['BITCOIN_CLI', 'STAKE_LOCK_BIN', 'CLIENT_DIR', 'FEDIMINT_CLI', 'INVITE_FILE', 'WORK_DIR']) if (!env[k]) { console.error(`${k} is needed`); process.exit(2); }
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const [cli, ...cliArgs] = env.BITCOIN_CLI.split(' ').filter(Boolean);
const bc = (...a) => execFileSync(cli, [...cliArgs, ...a.map(String)], { encoding: 'utf8' }).trim();
const rpc = async (method, params = []) => { const out = bc(method, ...params.map((p) => (typeof p === 'object' ? JSON.stringify(p) : p))); try { return JSON.parse(out); } catch { return out; } };
const runEnv = { ...process.env, ...(env.FORK_HOME ? { HOME: env.FORK_HOME } : {}) };
const sh = (bin, args, timeout = 300000) => { try { return execFileSync(bin, args, { encoding: 'utf8', env: runEnv, timeout, maxBuffer: 1 << 24 }); } catch (e) { return String(e.stdout || '') + String(e.message || ''); } };
const json = (out) => { const l = String(out).split('\n').find((x) => x.startsWith('{')); return l ? JSON.parse(l) : null; };
// a player key whose compressed form is 02.. (refundKeyOf names the x-only key with even y)
const player = () => { for (;;) { const sk = randomBytes(32); const pk = secp256k1.getPublicKey(sk, true); if (pk[0] === 2) return { sk: toHex(sk), x: toHex(schnorr.getPublicKey(sk)) }; } };
let code = 0;
try {
  const set = arbitrationMembers('regtest');
  const escrow = escrowOutput({ arbitrationKeys: set.keys, k: set.k }, { tweakPoint, combine });
  const escrowAddress = (await rpc('deriveaddresses', [(await rpc('getdescriptorinfo', [`rawtr(${toHex(escrow.outputKey)})`])).descriptor]))[0];
  const sats = 150000n;
  const posted = bc('sendtoaddress', escrowAddress, (Number(sats) / 1e8).toFixed(8));
  bc('generatetoaddress', 1, bc('getnewaddress'));
  const p1 = player(), p2 = player();
  const v = { posted, playersSats: String(sats), round: 'ab'.repeat(32), entry: 'cd'.repeat(32), players: [{ key: p1.x, sats: '90000' }, { key: p2.x, sats: '60000' }] };
  log({ step: 'slash recorded', posted, escrowSats: sats, players: v.players });
  // AS THE SERVICE'S PASS CALLS IT: once a minute there, every 15 s here, until it has paid
  const t0 = Date.now(); const said = [];
  for (let i = 0; i < 80 && !v.payouts; i++) {
    const r = await payOutSlash({ proof: 'regtest', v, set, rpc, bin: env.STAKE_LOCK_BIN, dir: env.CLIENT_DIR, env: runEnv, say: (o) => said.push(o) });
    if (r.why && !said.some((x) => x.why === r.why)) said.push({ why: r.why, s: Math.round((Date.now() - t0) / 1000) });
    if (!v.payouts) { bc('generatetoaddress', 1, bc('getnewaddress')); await new Promise((r2) => setTimeout(r2, 15000)); }
  }
  log({ step: 'payOutSlash', seconds: Math.round((Date.now() - t0) / 1000), escrowTxid: v.escrowTxid, pegInSats: v.pegInSats, claimedMsat: v.claimedMsat, payouts: v.payouts, said });
  if (!v.payouts) throw new Error('payOutSlash paid nothing');
  // EACH PLAYER REDEEMS ITS OWN, by refund, in a fresh client
  const invite = readFileSync(env.INVITE_FILE, 'utf8').trim();
  const redeemed = [];
  for (const [i, p] of [p1, p2].entries()) {
    const pay = v.payouts.find((x) => x.refundPk === `02${p.x}`);
    const dir = `${env.WORK_DIR}/slash-player-${i + 1}`; mkdirSync(dir, { recursive: true });
    sh(env.FEDIMINT_CLI, ['--data-dir', dir, 'join-federation', invite], 120000);
    const r = json(sh(env.STAKE_LOCK_BIN, ['--mode', 'redeem', '--data-dir', dir, '--outpoint', `${pay.txid}:${pay.outIdx}`, '--amount-msat', pay.msat,
      '--hash', '00'.repeat(32), '--claim-pk', pay.refundPk, '--refund-pk', pay.refundPk, '--expiration', '0', '--witness', 'refund', '--signer-secret', p.sk]));
    sh(env.FEDIMINT_CLI, ['--data-dir', dir, 'dev', 'wait-complete'], 180000);
    const info = json(sh(env.FEDIMINT_CLI, ['--data-dir', dir, 'info'], 120000));
    redeemed.push({ player: i + 1, msat: pay.msat, accepted: r && r.accepted, error: r && r.error, balanceMsat: info && info.total_amount_msat });
  }
  log({ step: 'redeemed', redeemed });
  if (!redeemed.every((x) => x.accepted)) code = 1;
} catch (e) { code = 1; log({ step: 'stopped', why: String(e.stack || e.message).slice(0, 500) }); }
process.exit(code);
