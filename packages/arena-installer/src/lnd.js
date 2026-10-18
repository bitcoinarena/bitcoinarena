// LIGHTNING FOR CUSTODY: LND, SET UP BY THE WIZARD (kanban #471 slice 5, "Custody help: set up LND (create or connect), its wallet and
// the gateway, test it; or connect an existing LND"). Ruling 2: LND publishes a Windows build itself, so this part runs on all three.
//
//   install    LND v0.21.4-beta for this system from its GitHub release, checked against the SHA-256 its manifest names; the
//              manifest's signature was checked against roasbeef's key from the LND repo (scripts/keys/roasbeef.asc) on 2026-10-18
//   configure  <home>/lnd/lnd.conf: testnet4 on the node's own Bitcoin Core (RPC polling, its cookie - no ZMQ needed), RPC and REST on
//              127.0.0.1 only (REST on 10080: 8080 is often taken), peers on 9735, the wallet unlocked from a password file at start
//   wallet     created from the node's own 24 words (a BIP32 key under its own tag, so one written seed covers it), its password random
//              and kept 0600 beside it; LND's channel backup file is not in the seed (said on the page)
//   test       getinfo over REST with the admin macaroon: its key, block height and whether it is synced to the chain
//   connect    an LND that already runs: its REST address, admin macaroon (hex) and TLS certificate, tested the same way
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import https from 'node:https';
import { taggedHash } from '../../arena-protocol/src/hash.js';

export const LND_VERSION = 'v0.21.4-beta';
/** The release files and their SHA-256 (manifest-v0.21.4-beta.txt, signature by roasbeef checked 2026-10-18). */
export const LND_FILES = Object.freeze({
  'linux-x64': { file: 'lnd-linux-amd64-v0.21.4-beta.tar.gz', sha256: 'beffe4949a5e46410d90c0e6d020a1b685468440b0004fc4d59740a6291178fb' },
  'linux-arm64': { file: 'lnd-linux-arm64-v0.21.4-beta.tar.gz', sha256: 'bc5fc872bf12002e1a1ea42b16a13e2f836c2e2439817f336a323bddf680b708' },
  'darwin-x64': { file: 'lnd-darwin-amd64-v0.21.4-beta.tar.gz', sha256: '9676ad611e904aa6c2a0d7752bd371e525d7d6b6307305b5423d721700dd9261' },
  'darwin-arm64': { file: 'lnd-darwin-arm64-v0.21.4-beta.tar.gz', sha256: '68893592bbd1ecc18eaf4911a2206da3e1fcd1b716f575b087f9270cd3829e03' },
  'win32-x64': { file: 'lnd-windows-amd64-v0.21.4-beta.zip', sha256: 'ddd334677f4eec19891f47b8277aa14a6c845852dcab351efe442fad35f176d2' },
});
/** LND's ports on this machine. */
export const LND_PORTS = Object.freeze({ rpc: 10009, rest: 10080, p2p: 9735 });
const LND_SEED_TAG = 'arena/lnd/v1';

const run = (cmd, args, opts = {}) => new Promise((resolve) => execFile(cmd, args, { timeout: 600000, ...opts }, (e, out, err) => resolve({ ok: !e, out: String(out), err: String(err) })));

/** Download and unpack LND for this system into <home>/lnd-bin, checked by SHA-256. Answers { ok, lnd, lncli, why }. */
export async function installLnd({ home, platform = process.platform, arch = process.arch, fetcher = fetch, sh = run }) {
  const f = LND_FILES[`${platform}-${arch}`];
  if (!f) return { ok: false, why: `no LND release for ${platform}-${arch}` };
  const dir = join(home, 'lnd-bin');
  mkdirSync(dir, { recursive: true });
  const sub = f.file.replace(/\.(tar\.gz|zip)$/, '');
  const exe = platform === 'win32' ? '.exe' : '';
  const lnd = join(dir, sub, `lnd${exe}`), lncli = join(dir, sub, `lncli${exe}`);
  if (existsSync(lnd)) return { ok: true, lnd, lncli, already: true };
  const r = await fetcher(`https://github.com/lightningnetwork/lnd/releases/download/${LND_VERSION}/${f.file}`);
  if (r.status !== 200) return { ok: false, why: `github.com answered ${r.status} for ${f.file}` };
  const bytes = Buffer.from(await r.arrayBuffer());
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== f.sha256) return { ok: false, why: `${f.file} is not the published file (sha256 ${sha.slice(0, 16)}, published ${f.sha256.slice(0, 16)})` };
  const archive = join(dir, f.file);
  writeFileSync(archive, bytes);
  const x = f.file.endsWith('.zip') ? await sh('tar', ['-xf', archive, '-C', dir]) : await sh('tar', ['-xzf', archive, '-C', dir]);
  if (!x.ok || !existsSync(lnd)) return { ok: false, why: `unpacking ${f.file} failed: ${x.err.trim().slice(0, 200)}` };
  return { ok: true, lnd, lncli, sha256: sha };
}

/**
 * <home>/lnd and its lnd.conf for testnet4 on the node's Bitcoin Core. `chain`: the wizard's chain step ({ url, cookiePath } or
 * { url, user, password }). Answers { lnddir, conf, passwordFile, restUrl, tlsCert, macaroon }.
 */
export function configureLnd({ home, chain, alias = 'arena-node', ports = LND_PORTS }) {
  const lnddir = join(home, 'lnd');
  mkdirSync(lnddir, { recursive: true, mode: 0o700 });
  const passwordFile = join(lnddir, 'wallet-password');
  if (!existsSync(passwordFile)) writeFileSync(passwordFile, randomBytes(24).toString('base64url'), { mode: 0o600 });
  const rpc = new URL(chain.url);
  const auth = chain.cookiePath ? [`bitcoind.rpccookie=${chain.cookiePath}`] : [`bitcoind.rpcuser=${chain.user}`, `bitcoind.rpcpass=${chain.password}`];
  const conf = [
    '; The Arena node\'s Lightning node (kanban #471 slice 5), written by the installer.',
    '[Application Options]', `alias=${alias}`, `listen=0.0.0.0:${ports.p2p}`, `rpclisten=127.0.0.1:${ports.rpc}`, `restlisten=127.0.0.1:${ports.rest}`,
    `wallet-unlock-password-file=${passwordFile}`, 'wallet-unlock-allow-create=true',
    '[Bitcoin]', 'bitcoin.active=true', 'bitcoin.testnet4=true', 'bitcoin.node=bitcoind',
    '[Bitcoind]', `bitcoind.rpchost=${rpc.hostname}:${rpc.port}`, ...auth, 'bitcoind.rpcpolling=true', '',
  ].join('\n');
  writeFileSync(join(lnddir, 'lnd.conf'), conf, { mode: 0o600 });
  return { lnddir, conf: join(lnddir, 'lnd.conf'), passwordFile, restUrl: `https://127.0.0.1:${ports.rest}`, tlsCert: join(lnddir, 'tls.cert'),
    macaroon: join(lnddir, 'data', 'chain', 'bitcoin', 'testnet4', 'admin.macaroon') };
}

/** The command line LND runs with (service.js installProgram makes it a service on each system). */
export const lndArgs = ({ lnd, lnddir }) => [lnd, `--lnddir=${lnddir}`, `--configfile=${join(lnddir, 'lnd.conf')}`];

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const base58check = (payload) => {
  const sum = createHash('sha256').update(createHash('sha256').update(payload).digest()).digest().subarray(0, 4);
  const b = Buffer.concat([payload, sum]);
  let n = BigInt('0x' + b.toString('hex')), s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of b) { if (x !== 0) break; s = '1' + s; }
  return s;
};

/** LND's wallet root from the node's seed: BIP32 master of a tagged hash of it, as a testnet tprv (LND's testnet4 runs on testnet keys). */
export const lndMasterKey = (seed) => bip32Master(taggedHash(LND_SEED_TAG, seed));
/** BIP32 master key of `entropy`, serialized as a testnet tprv (BIP32 test vector 1 in test/lnd.test.js). */
export function bip32Master(entropy) {
  const I = createHmac('sha512', 'Bitcoin seed').update(entropy).digest();
  const payload = Buffer.concat([Buffer.from('04358394', 'hex'), Buffer.alloc(1), Buffer.alloc(4), Buffer.alloc(4), I.subarray(32), Buffer.alloc(1), I.subarray(0, 32)]);
  return base58check(payload);
}

/** One REST call to LND (its own TLS certificate). Answers { status, json }. */
export function lndRest({ restUrl, tlsCertPem, macaroonHex, method = 'GET', path, body = null, timeoutMs = 15000, request = https.request }) {
  return new Promise((resolve) => {
    const u = new URL(path, restUrl);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, ca: tlsCertPem, timeout: timeoutMs,
      headers: { ...(macaroonHex ? { 'Grpc-Metadata-macaroon': macaroonHex } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(t); } catch { json = { text: t.slice(0, 300) }; } resolve({ status: res.statusCode, json }); });
    });
    req.on('timeout', () => req.destroy(new Error(`LND did not answer in ${timeoutMs / 1000} s`)));
    req.on('error', (e) => resolve({ status: 0, json: { error: e.message } }));
    if (data) req.write(data);
    req.end();
  });
}

/** Create LND's wallet from the seed (once: LND waits for it on first start). Answers { ok, created, why }. */
export async function createLndWallet({ cfg, seed, nowMs = Date.now(), rest = lndRest }) {
  if (existsSync(cfg.macaroon)) return { ok: true, created: false };
  if (!existsSync(cfg.tlsCert)) return { ok: false, why: 'LND is starting (no TLS certificate yet)' };
  const password = readFileSync(cfg.passwordFile, 'utf8').trim();
  const r = await rest({ restUrl: cfg.restUrl, tlsCertPem: readFileSync(cfg.tlsCert), method: 'POST', path: '/v1/initwallet',
    body: { wallet_password: Buffer.from(password).toString('base64'), extended_master_key: lndMasterKey(seed), extended_master_key_birthday_timestamp: String(Math.floor(nowMs / 1000)) } });
  if (r.status === 200) return { ok: true, created: true };
  const why = (r.json && (r.json.message || r.json.error)) || `LND answered ${r.status}`;
  if (/already exists|wallet already/i.test(why)) return { ok: true, created: false };
  return { ok: false, why };
}

/**
 * LND, tested: getinfo with the admin macaroon. `cfg`: { restUrl, tlsCert (a path) or tlsCertPem, macaroon (a path) or macaroonHex }.
 * Answers { ok, pubkey, alias, blockHeight, syncedToChain, network, version, why }.
 */
export async function testLnd(cfg, { rest = lndRest } = {}) {
  let tlsCertPem, macaroonHex;
  try {
    tlsCertPem = cfg.tlsCertPem || readFileSync(cfg.tlsCert);
    macaroonHex = cfg.macaroonHex || (cfg.macaroonHexFile ? readFileSync(cfg.macaroonHexFile, 'utf8').trim() : readFileSync(cfg.macaroon).toString('hex'));
  } catch (e) { return { ok: false, why: `LND's certificate or macaroon is not there yet (${e.code || e.message})` }; }
  const r = await rest({ restUrl: cfg.restUrl, tlsCertPem, macaroonHex, path: '/v1/getinfo' });
  if (r.status !== 200) return { ok: false, why: (r.json && (r.json.message || r.json.error)) || `LND answered ${r.status}` };
  const g = r.json;
  const network = ((g.chains || [])[0] || {}).network || null;
  if (network && network !== 'testnet4') return { ok: false, why: `this LND runs on ${network}, not testnet4` };
  return { ok: true, pubkey: g.identity_pubkey, alias: g.alias, blockHeight: g.block_height, syncedToChain: Boolean(g.synced_to_chain), network, version: g.version };
}

// CHANNELS FOR A GATEWAY SEAT (spec §23A.9: public channel capacity >= 200,000 sat on testnet4): LND's own on-chain wallet takes the
// deposit, then a channel to a peer the owner names. Each call reads LND's certificate and admin macaroon as testLnd does.
const credsOf = (cfg) => ({ restUrl: cfg.restUrl, tlsCertPem: cfg.tlsCertPem || readFileSync(cfg.tlsCert),
  macaroonHex: cfg.macaroonHex || (cfg.macaroonHexFile ? readFileSync(cfg.macaroonHexFile, 'utf8').trim() : readFileSync(cfg.macaroon).toString('hex')) });
const errOf = (r) => (r.json && (r.json.message || r.json.error)) || `LND answered ${r.status}`;

/** LND's on-chain deposit address (taproot) and its balances. Answers { ok, address, onchainSats, unconfirmedSats, channelSats, why }. */
export async function lndFunds(cfg, { rest = lndRest } = {}) {
  let c; try { c = credsOf(cfg); } catch (e) { return { ok: false, why: `LND's certificate or macaroon is not there yet (${e.code || e.message})` }; }
  const [a, b, ch] = await Promise.all([rest({ ...c, path: '/v1/newaddress?type=4' }), rest({ ...c, path: '/v1/balance/blockchain' }), rest({ ...c, path: '/v1/balance/channels' })]);
  if (a.status !== 200) return { ok: false, why: errOf(a) };
  return { ok: true, address: a.json.address, onchainSats: Number((b.json || {}).confirmed_balance || 0), unconfirmedSats: Number((b.json || {}).unconfirmed_balance || 0),
    channelSats: Number(((ch.json || {}).local_balance || {}).sat || (ch.json || {}).balance || 0) };
}

/** Connect to `peer` (pubkey@host:port) and open a public channel of `sats`. Answers { ok, fundingTxid, why }. */
export async function lndOpenChannel(cfg, { peer, sats }, { rest = lndRest } = {}) {
  const m = /^(0[23][0-9a-f]{64})@([^\s:]+|\[[0-9a-f:]+\]):(\d{1,5})$/i.exec(String(peer || '').trim());
  if (!m) return { ok: false, why: 'a peer is pubkey@host:port' };
  const amount = Math.floor(Number(sats));
  if (!(amount >= 20000)) return { ok: false, why: 'a channel is at least 20,000 sat' };
  const c = credsOf(cfg);
  const con = await rest({ ...c, method: 'POST', path: '/v1/peers', body: { addr: { pubkey: m[1].toLowerCase(), host: `${m[2]}:${m[3]}` }, perm: true, timeout: 20 } });
  if (con.status !== 200 && !/already connected/i.test(errOf(con))) return { ok: false, why: `could not reach the peer: ${errOf(con)}` };
  const o = await rest({ ...c, method: 'POST', path: '/v1/channels', timeoutMs: 60000,
    body: { node_pubkey: Buffer.from(m[1], 'hex').toString('base64'), local_funding_amount: String(amount), private: false } });
  if (o.status !== 200) return { ok: false, why: `the channel was not opened: ${errOf(o)}` };
  const raw = o.json.funding_txid_bytes ? Buffer.from(o.json.funding_txid_bytes, 'base64').reverse().toString('hex') : o.json.funding_txid_str || null;
  return { ok: true, fundingTxid: raw };
}

/** LND's channels: open (active or not) and pending, with their capacity. Answers { ok, open, pending, publicCapacitySats }. */
export async function lndChannels(cfg, { rest = lndRest } = {}) {
  let c; try { c = credsOf(cfg); } catch (e) { return { ok: false, why: e.message }; }
  const [o, p] = await Promise.all([rest({ ...c, path: '/v1/channels' }), rest({ ...c, path: '/v1/channels/pending' })]);
  if (o.status !== 200) return { ok: false, why: errOf(o) };
  const open = (o.json.channels || []).map((x) => ({ peer: x.remote_pubkey, capacitySats: Number(x.capacity), active: Boolean(x.active), public: !x.private }));
  const pending = ((p.json || {}).pending_open_channels || []).map((x) => ({ peer: x.channel.remote_node_pub, capacitySats: Number(x.channel.capacity) }));
  return { ok: true, open, pending, publicCapacitySats: open.filter((x) => x.public).reduce((a, x) => a + x.capacitySats, 0) };
}
