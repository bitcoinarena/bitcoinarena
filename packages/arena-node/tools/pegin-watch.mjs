#!/usr/bin/env node
// THE PEG-IN WATCHER, WHICH CHECKS BEFORE IT WAITS (the owner 2026-09-29 12:25, PEGIN-WATCH-1225; the rule is
// src/pegin-check.js). Every tick it reads: the gateway's client config for the federation (gateway-cli cfg
// client-config), the running federation's config (a separate outside client, fedimint-cli config), the address the
// peg-in transaction paid (off the chain), whether the gateway's current client derived that address (ecash
// pegin-recheck - "Address not found in the list of derived keys" is a no), the confirmations and the gateway's e-cash.
//
// A MISMATCH IS PRINTED AND THE WATCHER EXITS 3 AT ONCE - it is never reported as maturing. A credit prints
// "GATEWAY <label> CREDITED" and exits 0. Anything else prints the verdict and looks again.
//
//   ARENA_PEGIN=<txid>:<vout> ARENA_GATEWAY_LABEL=B ARENA_GATEWAY_API=http://127.0.0.1:31280 \
//   ARENA_GATEWAY_PASSWORD_FILE=~/blwp-testnet4/gw-b/password ARENA_FEDERATION_ID=<hex> \
//   ARENA_OUTSIDE_CLIENT_DIR=~/blwp-testnet4/patched/cli-outside [ARENA_CURRENT_ADDRESS_FILE=...] \
//   [ARENA_TN4_WALLET=blwp-tn4-bonds, the wallet that paid it] [ARENA_WANT_MSAT=10068942] [ARENA_EVERY_S=300] [--once] node tools/pegin-watch.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { peginVerdict } from '../src/pegin-check.js';

const env = process.env;
const home = env.ARENA_TESTNET4_DIR || `${env.HOME}/blwp-testnet4`;
const [txid, vout] = String(env.ARENA_PEGIN || '').split(':');
if (!/^[0-9a-f]{64}$/.test(txid || '') || !/^\d+$/.test(vout || '')) throw new Error('ARENA_PEGIN=<txid>:<vout>: the peg-in to watch');
const fid = env.ARENA_FEDERATION_ID;
if (!/^[0-9a-f]{64}$/.test(fid || '')) throw new Error('ARENA_FEDERATION_ID: the federation the peg-in is for');
const label = env.ARENA_GATEWAY_LABEL || 'B';
const api = env.ARENA_GATEWAY_API || 'http://127.0.0.1:31280';
const password = readFileSync(env.ARENA_GATEWAY_PASSWORD_FILE || `${home}/gw-b/password`, 'utf8').trim();
const outside = env.ARENA_OUTSIDE_CLIENT_DIR || `${home}/patched/cli-outside`;
const exec = env.ARENA_TAILNET_EXEC || `${home}/tailnet-exec`;
const wantMsat = BigInt(env.ARENA_WANT_MSAT || 10068942);
const everyMs = Number(env.ARENA_EVERY_S || 300) * 1000;
const btc = (...a) => execFileSync(env.BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli',
  [`-datadir=${env.ARENA_TN4_DATADIR || '/mnt/bitcoin/tn4'}`, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 }).trim();
const gw = (...a) => execFileSync(exec, ['gateway-cli', '--address', api, '--rpcpassword', password, ...a],
  { encoding: 'utf8', timeout: 120000, maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
const say = (s) => console.log(`${new Date().toISOString()} peg-in ${txid.slice(0, 8)}:${vout} gateway ${label}: ${s}`);

function tick() {
  const gatewayConfig = JSON.parse(gw('cfg', 'client-config', '--federation-id', fid)).federations[fid];
  if (!gatewayConfig) return { state: 'mismatch', why: `the gateway holds no config for federation ${fid.slice(0, 16)}` };
  const federation = JSON.parse(execFileSync('fedimint-cli', ['--data-dir', outside, 'config'], { encoding: 'utf8', timeout: 120000, maxBuffer: 16 << 20 }));
  // THE PAYING WALLET'S VIEW OF IT (this bitcoind keeps no txindex): its decoded outputs and its confirmations
  const tx = JSON.parse(btc(`-rpcwallet=${env.ARENA_TN4_WALLET || 'blwp-tn4-bonds'}`, 'gettransaction', txid, 'true', 'true'));
  const address = tx.decoded.vout[Number(vout)].scriptPubKey.address;
  const confirmations = Number(tx.confirmations || 0);
  let derivedByGateway = null;
  try { gw('ecash', 'pegin-recheck', '--address', address, '--federation-id', fid); derivedByGateway = true; }
  catch (e) { if (/Invalid request|not found in the list of derived keys/.test(`${e.stdout || ''}${e.stderr || ''}`)) derivedByGateway = false; }
  const balances = JSON.parse(gw('get-balances')).ecash_balances || [];
  const balanceMsat = BigInt((balances.find((b) => b.federation_id === fid) || {}).ecash_balance_msats || 0);
  const currentFile = env.ARENA_CURRENT_ADDRESS_FILE;
  const currentAddress = currentFile && existsSync(currentFile) ? readFileSync(currentFile, 'utf8').trim() : null;
  return peginVerdict({ federation, gateway: gatewayConfig, address, currentAddress, derivedByGateway, confirmations, balanceMsat, wantMsat });
}

for (;;) {
  let v;
  try { v = tick(); } catch (e) { v = { state: 'unchecked', why: `could not read everything: ${String(e.message).split('\n')[0]}` }; }
  if (v.state === 'mismatch') { say(`PEG-IN MISMATCH: ${v.why}`); process.exit(3); }
  if (v.state === 'credited') { say(`GATEWAY ${label} CREDITED: ${v.why}`); process.exit(0); }
  say(`${v.state}: ${v.why}`);
  if (process.argv.includes('--once')) process.exit(0);
  await new Promise((r) => setTimeout(r, everyMs));
}
