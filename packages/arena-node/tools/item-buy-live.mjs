// item-buy-live.mjs (kanban #369): the larger truck bought for real on testnet4 with the PAGE'S OWN purchase code (arena-client
// item-buy.js buyItem) - the manifest the seats host (GET /games: nextblock v3, which sells it), a fresh wasm wallet in the
// federation funded over Lightning from lnd-testnet4, the buyer the ITEMS KEY of a player seed (itemsKeyFor), and the record handed
// to a seat, which hands it on; then GET /items asked of every seat.
// env: SEATS (comma list), ROUND (a paid round of the game whose donation sets to read), INVITE_FILE, WASM_PKG, LNCLI, PAYER_DIR,
//      PAYER_RPC, GATEWAY, SEED_FILE (64 hex: the player seed the purchase belongs to; written 0600 when absent), WALLET_FILE
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { buyItem, ownedItems, itemsKeyFor, shopOf } from '../../arena-client/src/item-buy.js';
import { decodeDonationSet } from '../../arena-protocol/src/donation.js';
import { decodeDonationSetBody } from '../../arena-protocol/src/authority.js';
import { decodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const env = process.env;
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v)));
const run = (bin, args) => new Promise((ok) => execFile(bin, args, { timeout: 180000 }, (e, out, err) => ok({ code: e ? e.code || 1 : 0, out: String(out), err: String(err) })));
const payer = (...a) => run(env.LNCLI, [`--lnddir=${env.PAYER_DIR}`, `--rpcserver=${env.PAYER_RPC}`, '--network=testnet4', ...a]);
const seats = env.SEATS.split(',');
const get = async (u, kind = 'json') => { const r = await fetch(u, { signal: AbortSignal.timeout(30000) }); if (!r.ok) throw new Error(`${u}: ${r.status}`); return kind === 'json' ? r.json() : new Uint8Array(await r.arrayBuffer()); };
const curve = { pointX: (sk) => schnorr.getPublicKey(sk), signSchnorr: (m, sk) => schnorr.sign(m, sk) };

// THE PLAYER: a seed kept on disk, so a page restored from it owns what this buys
if (!existsSync(env.SEED_FILE)) writeFileSync(env.SEED_FILE, toHex(randomBytes(32)) + '\n', { mode: 0o600 });
const seed = fromHex(readFileSync(env.SEED_FILE, 'utf8').trim());
const key = itemsKeyFor(seed, curve);
log({ step: 'player', itemsKey: toHex(key.pubkey) });

// THE GAME AS THE SEATS HOST IT: every version GET /games lists, the shop the page would show
const games = [];
for (const g of (await get(`${seats[0]}/games`)).games || []) {
  const m = decodeManifest(fromHex(g.manifest));
  games.push({ id: toHex(gameIdOf(m)), name: m.gameName, manifest: m, nodes: seats });
}
const shop = shopOf(games, 'nextblock');
if (!shop) { log({ step: 'shop', why: 'no hosted version of nextblock sells anything' }); process.exit(2); }
log({ step: 'shop', game: shop.game.id, version: shop.game.manifest.version, items: shop.items });

// THE TWO DONATION SETS, as a seat serves them for a paid round of the game
const netBytes = await get(`${seats[0]}/donation-set?round=${env.ROUND}`, 'bytes');
const networkSet = decodeDonationSetBody(netBytes.subarray(0, netBytes.length - 64)).recipients;
const gameSet = decodeDonationSet(await get(`${seats[0]}/game-donation-set?round=${env.ROUND}`, 'bytes'));

// A FRESH WALLET IN THE FEDERATION, FUNDED OVER LIGHTNING
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const esm = join(tmpdir(), `item-buy-${process.pid}.mjs`); copyFileSync(join(env.WASM_PKG, 'blwp_lock_client.js'), esm);
const wasm = await import(esm); await wasm.default({ module_or_path: readFileSync(join(env.WASM_PKG, 'blwp_lock_client_bg.wasm')) });
const invite = readFileSync(env.INVITE_FILE, 'utf8').trim();
const federationId = wasm.LockClient.federationIdOf(invite);
// KEPT ON DISK (WALLET_FILE, 0600): its secret and its store, so a deposit outlives the process (a first run stranded 700 sat in memory)
const saved = existsSync(env.WALLET_FILE) ? JSON.parse(readFileSync(env.WALLET_FILE, 'utf8')) : { secret: toHex(randomBytes(32)), store: [] };
const kept = new Map(saved.store);
const persist = () => writeFileSync(env.WALLET_FILE, JSON.stringify({ secret: saved.secret, store: [...kept] }), { mode: 0o600 });
persist();
const wallet = await wasm.LockClient.join(invite, federationId, saved.secret, { entries: () => JSON.stringify([...kept]), put: (k, v) => { kept.set(k, v); persist(); }, remove: (k) => { kept.delete(k); persist(); } });
if (BigInt(await wallet.balanceMsat()) < 600000n) {
  const rcv = JSON.parse(await wallet.receive(String(700000n), env.GATEWAY));
  const paid = await payer('payinvoice', '--force', '--timeout', '90s', rcv.invoice);
  const final = await wallet.awaitReceive(rcv.operation);
  log({ step: 'deposit', paid: (paid.out.match(/Payment status: [A-Z_]+/) || [paid.err.slice(0, 160)])[0], final });
}
log({ step: 'wallet', federation: federationId.slice(0, 16), balanceMsat: await wallet.balanceMsat() });

// THE PURCHASE, as the page makes it
const t0 = Date.now();
const got = await buyItem({ manifest: shop.game.manifest, itemId: 'large-truck', networkSet, gameSet, wallet, federationId, player: { pubkey: key.pubkey, sign: key.sign },
  seats, fetch: (u, o) => fetch(u, o), verify: (sg, m, k) => schnorr.verify(sg, m, k) });
log({ step: 'bought', ms: Date.now() - t0, ...got, balanceMsat: await wallet.balanceMsat() });
if (!got.ok) process.exit(1);

// EVERY SEAT, ASKED WHAT THIS PLAYER OWNS (the record is handed on seat to seat)
await new Promise((r) => setTimeout(r, 15000));
const rows = await Promise.all(seats.map(async (s) => {
  const items = await ownedItems({ seats: [s], player: key.pubkey, gameName: 'nextblock', fetch: (u, o) => fetch(u, o) }).catch(() => null);
  return { seat: s.replace(/^https?:\/\//, ''), owns: items ? items.filter((i) => i.id === got.purchaseId).map((i) => i.itemId) : null };
}));
log({ step: 'kept', seats: rows });
process.exit(0);
