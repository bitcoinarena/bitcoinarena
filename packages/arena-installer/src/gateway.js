// THE GATEWAY FOR CUSTODY (kanban #471 slice 5, part 2: "Custody help: set up LND ..., its wallet and the gateway, test it"): the
// patched fork's gatewayd (custody binaries beside the release, runtime/custody/), on this node's LND, joined to federations by invite.
//
//   find       gatewayd in the release (runtime/custody/gatewayd[.exe]) - a release without it says so; no download of unsigned binaries
//   configure  <home>/gateway: its data, an admin password (random, 0600) whose bcrypt hash gatewayd checks, its mnemonic from the
//              node's own 24 words (a tagged key of the seed as BIP-39 words, so one written seed recovers the gateway's e-cash too),
//              the chain from an Esplora server (the cookie of a Core changes at every restart; a Core the user runs has no password
//              to give it), LND by its RPC address, tls.cert and admin macaroon
//   test       GET /v1/info with the admin password: its id, network, the federations it serves
//   join       POST /v1/connect_fed with an invite code (ruling 3: a federation is joined by invite)
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { phraseFromSeed } from '../../arena-client/src/bip39.js';
import { taggedHash } from '../../arena-protocol/src/hash.js';
import { LND_PORTS } from './lnd.js';

export const GATEWAY_PORT = 8476;
export const TESTNET4_ESPLORA = 'https://mempool.space/testnet4/api';
const GATEWAY_SEED_TAG = 'arena/gateway/v1';

/** gatewayd in the release, or why not. */
export function findGatewayd({ release, platform = process.platform, arch = process.arch }) {
  const bin = join(release, 'runtime', 'custody', platform === 'win32' ? 'gatewayd.exe' : 'gatewayd');
  return existsSync(bin) ? { ok: true, gatewayd: bin } : { ok: false, why: `this release carries no gateway for ${platform}-${arch} yet (runtime/custody/ is missing)` };
}

/** The gateway's BIP-39 words from the node's seed (its own tagged key: not the seed's words). */
export const gatewayMnemonicOf = (seed) => phraseFromSeed(taggedHash(GATEWAY_SEED_TAG, seed)).words.join(' ');

/**
 * <home>/gateway: data dir, admin password (kept), its bcrypt hash. `lnd`: { lnddir? tlsCert, macaroon, rpcHost }. Answers { dir, args,
 * vars, apiUrl, passwordFile }: `args` the command line, `vars` its environment (the mnemonic) for service.js installProgram.
 */
export function configureGateway({ home, gatewayd, seed, lnd, port = GATEWAY_PORT, apiUrl = `http://127.0.0.1:${port}`, publicUrl = null, esplora = TESTNET4_ESPLORA, cost = 10 }) {
  const dir = join(home, 'gateway');
  mkdirSync(join(dir, 'data'), { recursive: true, mode: 0o700 });
  const passwordFile = join(dir, 'admin-password');
  if (!existsSync(passwordFile)) writeFileSync(passwordFile, randomBytes(24).toString('base64url'), { mode: 0o600 });
  const hash = bcrypt.hashSync(readFileSync(passwordFile, 'utf8').trim(), cost);
  // --api-addr is where the federation's clients reach it: the node's public address /gateway/ (the seat carries it here); apiUrl, local, is ours
  const args = [gatewayd, `--data-dir=${join(dir, 'data')}`, `--listen=127.0.0.1:${port}`, `--api-addr=${publicUrl || apiUrl}`, `--bcrypt-password-hash=${hash}`,
    '--network=testnet4', `--esplora-url=${esplora}`, '--skip-setup',   // the mnemonic is the seed's (FM_GATEWAY_MNEMONIC), not set up in its own UI
    'lnd', `--lnd-rpc-host=${lnd.rpcHost || `https://127.0.0.1:${LND_PORTS.rpc}`}`, `--lnd-tls-cert=${lnd.tlsCert}`, `--lnd-macaroon=${lnd.macaroon}`];
  return { dir, args, vars: { FM_GATEWAY_MNEMONIC: gatewayMnemonicOf(seed) }, apiUrl, publicUrl: publicUrl || apiUrl, passwordFile };
}

const call = async ({ apiUrl, passwordFile, path, method = 'GET', body, fetcher = fetch }) => {
  try {
    const r = await fetcher(`${apiUrl}/v1${path}`, { method, signal: AbortSignal.timeout(20000),
      headers: { authorization: `Bearer ${readFileSync(passwordFile, 'utf8').trim()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { json = { text: text.slice(0, 300) }; }
    return { status: r.status, json };
  } catch (e) { return { status: 0, json: { error: e.cause ? e.cause.code || e.message : e.message } }; }
};

/** The gateway, tested: its info. Answers { ok, state, lightningPubkey, network, blockHeight, syncedToChain, federations, why }. */
export async function testGateway({ apiUrl, passwordFile, fetcher = fetch }) {
  const r = await call({ apiUrl, passwordFile, path: '/info', fetcher });
  if (r.status !== 200) return { ok: false, why: r.status === 0 ? `the gateway does not answer yet (${r.json.error})` : `the gateway answered ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}` };
  const g = r.json;
  // lightning_info is { connected: { public_key, alias, network, block_height, synced_to_chain } } or "not_connected" (serde's enum)
  const li = g.lightning_info && typeof g.lightning_info === 'object' ? (g.lightning_info.connected || g.lightning_info.Connected || null) : null;
  if (!li) return { ok: false, why: `the gateway runs but has no Lightning node yet (${g.gateway_state || 'starting'})`, state: g.gateway_state || null };
  if (li.network && !/testnet4/i.test(String(li.network))) return { ok: false, why: `this gateway's LND runs on ${li.network}, not testnet4` };
  return { ok: true, state: g.gateway_state || null, lightningPubkey: li.public_key, lightningAlias: li.alias, network: li.network, blockHeight: li.block_height,
    syncedToChain: Boolean(li.synced_to_chain), federations: (g.federations || []).map((f) => ({ federationId: f.federation_id, name: f.federation_name || null, balanceMsat: f.balance_msat })) };
}

/** Join a federation by its invite code. Answers { ok, federationId, why }. */
export async function joinFederation({ apiUrl, passwordFile, invite, fetcher = fetch }) {
  if (!/^fed1[0-9a-z]+$/.test(String(invite || '').trim())) return { ok: false, why: 'an invite code starts with fed1' };
  const r = await call({ apiUrl, passwordFile, path: '/connect_fed', method: 'POST', body: { invite_code: String(invite).trim(), use_tor: false, recover: false }, fetcher });
  if (r.status !== 200) return { ok: false, why: `the gateway refused: ${JSON.stringify(r.json).slice(0, 300)}` };
  return { ok: true, federationId: r.json.federation_id || null };
}

/** The gateway's peg-in address for a federation it serves (POST /v1/address). Answers { ok, address, why }. */
export async function depositAddress({ apiUrl, passwordFile, federationId, fetcher = fetch }) {
  const r = await call({ apiUrl, passwordFile, path: '/address', method: 'POST', body: { federation_id: federationId }, fetcher });
  const address = typeof r.json === 'string' ? r.json : r.json && (r.json.address || r.json.text);
  if (r.status !== 200 || !/^(tb1|bcrt1|bc1)[0-9a-z]+$/.test(String(address || ''))) return { ok: false, why: `the gateway gave no peg-in address: ${JSON.stringify(r.json).slice(0, 200)}` };
  return { ok: true, address };
}
