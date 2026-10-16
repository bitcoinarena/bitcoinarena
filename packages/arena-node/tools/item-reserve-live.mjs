// item-reserve-live.mjs (kanban #397 slice 5): one larger truck bought for real on testnet4 from Tick Tock v4 - the version that requires
// protocol 11 - so 20 % of its list price is paid to the payment federation's 5-of-7 reserve key; then every seat's GET /reserves and
// GET /items is read, to see the same reserve row and the same total on each. A fresh wasm wallet, funded over Lightning from
// lnd-testnet4, pays purchaseOutputsReserves with the lock client's paySubmit; the buyer's layout-12 record is handed to one seat,
// which checks it and hands it on to every other.
// env: SEATS (comma list, all 14), ROUND (a paid Tick Tock round of the federation, for its donation sets), INVITE_FILE, WASM_PKG,
//      LNCLI, PAYER_DIR, PAYER_RPC, GATEWAY, DEVS_PCT (default 40), WAIT_S (how long to read the seats, default 300)
import { readFileSync, copyFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { servedNodes, mergeServedRounds, SERVED_WINDOW_MS } from '../../arena-protocol/src/served-nodes.js';
import { purchaseOutputsReserves, purchaseId, purchaseStands, encodePurchase } from '../../arena-protocol/src/purchase.js';
import { decodeDonationSet } from '../../arena-protocol/src/donation.js';
import { decodeDonationSetBody } from '../../arena-protocol/src/authority.js';
import { gameIdOf } from '../../arena-protocol/src/manifest.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { MANIFEST_V4 } from '../../nextblock/plugin/nextblock-v4.js';

const env = process.env;
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const run = (bin, args) => new Promise((ok) => execFile(bin, args, { timeout: 180000 }, (e, out, err) => ok({ code: e ? e.code || 1 : 0, out: String(out), err: String(err) })));
const payer = (...a) => run(env.LNCLI, [`--lnddir=${env.PAYER_DIR}`, `--rpcserver=${env.PAYER_RPC}`, '--network=testnet4', ...a]);
const seats = env.SEATS.split(',');
const get = async (u, kind = 'json') => { const r = await fetch(u, { signal: AbortSignal.timeout(30000) }); if (!r.ok) throw new Error(`${u}: ${r.status}`); return kind === 'json' ? r.json() : new Uint8Array(await r.arrayBuffer()); };
const devsPct = Number(env.DEVS_PCT || 40);

// 0. THE WALLET'S FEDERATION AND ITS RESERVE KEY: taken only when at least five seats name the same one (as the page does)
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const esm = join(tmpdir(), `item-reserve-${process.pid}.mjs`); copyFileSync(join(env.WASM_PKG, 'blwp_lock_client.js'), esm);
const m = await import(esm); await m.default({ module_or_path: readFileSync(join(env.WASM_PKG, 'blwp_lock_client_bg.wasm')) });
const invite = readFileSync(env.INVITE_FILE, 'utf8').trim();
const fedHex = m.LockClient.federationIdOf(invite);
const said = new Map();
await Promise.all(seats.map(async (s) => { try { const f = ((await get(`${s}/reserves`)).federations || []).find((x) => x.federationId === fedHex && x.key);
  if (f) said.set(f.key, (said.get(f.key) || 0) + 1); } catch { /* names nothing */ } }));
const best = [...said.entries()].sort((a, b) => b[1] - a[1])[0];
if (!best || best[1] < 5) { log({ step: 'reserve key', fed: fedHex.slice(0, 8), refused: best ? `only ${best[1]} name ${best[0].slice(0, 16)}` : 'none names one' }); process.exit(1); }
const reserveKey = fromHex(best[0]);
log({ step: 'reserve key', fed: fedHex.slice(0, 8), key: best[0], agreeing: best[1], of: seats.length });

// 1. THE TWO DONATION SETS, as a seat serves them for a round of the game
const netBytes = await get(`${seats[0]}/donation-set?round=${env.ROUND}`, 'bytes');
const networkSet = decodeDonationSetBody(netBytes.subarray(0, netBytes.length - 64)).recipients;
const gameSet = decodeDonationSet(await get(`${seats[0]}/game-donation-set?round=${env.ROUND}`, 'bytes'));
log({ step: 'sets', network: networkSet.map((r) => [r.label, r.shareBps]), game: gameSet.map((r) => [r.label, r.shareBps]) });

// 2. WHO SERVED IN THE 24 H BEFORE NOW, from every seat's FINALs
const toMs = BigInt(Date.now() - 60000), fromMs = toMs - BigInt(SERVED_WINDOW_MS);
const held = [];
for (const s of seats) { try { const a = await get(`${s}/served?to=${toMs}&finals=1`); held.push((a.held || []).map((r) => ({ roundId: fromHex(r.roundId), committee: r.committee.map(fromHex), finals: r.finals.map(fromHex) }))); } catch { /* not this seat */ } }
const served = servedNodes({ rounds: mergeServedRounds(held).rounds, fromMs, toMs, verify: (sg, msg, k) => schnorr.verify(sg, msg, k) });
log({ step: 'served', seats: held.length, rounds: served.rounds, nodes: served.nodes.length, root: served.root });

// 3. THE SPLIT OF 500 SAT ON THE RESERVES' TERMS
const item = MANIFEST_V4.items.find((x) => x.id === 'large-truck');
const built = purchaseOutputsReserves({ priceSat: item.priceSat, servedKeys: served.nodes.map((n) => n.key), networkSet, gameSet, devsPct, reserveKey });
log({ step: 'split', outputs: built.outputs.length, devsPct, nodesMsat: built.split.nodesMsat, perNodeMsat: built.split.perNodeMsat, reserveMsat: built.reserve.msat,
  devsMsat: built.split.protocolDevsMsat + built.split.gameDevsMsat, sum: built.outputs.reduce((t, o) => t + o.msat, 0n) });

// 4. A FRESH WALLET, FUNDED OVER LIGHTNING
const kept = new Map();
const lc = await m.LockClient.join(invite, fedHex, toHex(randomBytes(32)), { entries: () => JSON.stringify([...kept]), put: (k, v) => { kept.set(k, v); }, remove: (k) => { kept.delete(k); } });
const rcv = JSON.parse(await lc.receive(String(700000n), env.GATEWAY));
const paid = await payer('payinvoice', '--force', '--timeout', '90s', rcv.invoice);
const final = await lc.awaitReceive(rcv.operation);
log({ step: 'deposit', paid: (paid.out.match(/Payment status: [A-Z_]+/) || [paid.err.slice(0, 160)])[0], final, balanceMsat: await lc.balanceMsat() });

// 5. THE PAYMENT: paySubmit, then lockAccepted
const buyerSecret = randomBytes(32), buyer = schnorr.getPublicKey(buyerSecret);
const submitted = JSON.parse(await lc.paySubmit(JSON.stringify(built.outputs.map((o) => ({ pk: toHex(o.pk), msat: String(o.msat), image: toHex(buyer) })))));
const accepted = JSON.parse(await lc.lockAccepted(JSON.stringify(submitted)));
const outs = accepted.donations || [];
log({ step: 'paid', txid: submitted.txid, outputs: outs.length, idsMatch: outs.every((d) => d.ids_match), sum: outs.reduce((t, d) => t + BigInt(d.amount_msat), 0n),
  reserveOut: outs.filter((d) => d.recipient_pk === toHex(reserveKey)).map((d) => [d.out_idx, d.amount_msat]) });

// 6. THE BUYER'S LAYOUT-12 RECORD, checked here as a seat checks it, then handed to the first seat
const rec = { gameDevPubkey: MANIFEST_V4.gameDevPubkey, gameName: MANIFEST_V4.gameName, itemId: item.id, priceSat: item.priceSat, devsPct, gameId: gameIdOf(MANIFEST_V4), reserveKey,
  playerPubkey: buyer, federationId: fromHex(fedHex), txid: fromHex(submitted.txid), servedFromMs: fromMs, servedToMs: toMs, servedRoot: fromHex(served.root),
  outputs: outs.map((d) => ({ outIdx: Number(d.out_idx), pk: fromHex(d.recipient_pk), msat: BigInt(d.amount_msat) })), boughtAtMs: BigInt(Date.now()) };
rec.signature = schnorr.sign(purchaseId(rec), buyerSecret);
const st = purchaseStands(rec, { manifest: MANIFEST_V4, networkSet, gameSet, served: { fromMs, toMs, nodes: served.nodes, root: served.root }, verify: (sg, msg, k) => schnorr.verify(sg, msg, k), reserveKey });
log({ step: 'record', stands: st.ok, why: st.why || null, purchase: toHex(purchaseId(rec)), player: toHex(buyer) });
const body = JSON.stringify({ purchase: toHex(encodePurchase(rec)), signature: toHex(rec.signature) });
for (const s of seats) {
  const r = await fetch(`${s}/item-purchase`, { method: 'POST', body, signal: AbortSignal.timeout(120000) }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
  const t = (await r.text()).trim().slice(0, 200);
  log({ step: 'handed', seat: s, status: r.status, said: t });
  if (r.ok) break;
}

// 7. EVERY SEAT: the reserve row, the federation's total, the buyer's ownership
const want = toHex(purchaseId(rec));
const read = async () => Promise.all(seats.map(async (s) => {
  try {
    const r = await get(`${s}/reserves`);
    const f = (r.federations || []).find((x) => x.federationId === fedHex) || {};
    const row = (f.paidIn || []).find((p) => p.entryId === want);
    const items = await get(`${s}/items?player=${toHex(buyer)}`).then((x) => x.items || []).catch(() => []);
    return { seat: s, heldMsat: f.heldMsat ?? null, totalMsat: r.totalMsat ?? null, row: row ? `${row.amountMsat} msat · ${row.item || '-'}` : null, owns: items.some((i) => i.id === want) };
  } catch (e) { return { seat: s, error: e.message }; }
}));
const until = Date.now() + Number(env.WAIT_S || 300) * 1000;
let last;
do { await new Promise((ok) => setTimeout(ok, 20000)); last = await read(); } while (Date.now() < until && !last.every((x) => x.row && x.owns));
log({ step: 'seats', all: last.every((x) => x.row && x.owns), seen: last.filter((x) => x.row).length, of: last.length });
for (const x of last) log({ step: 'seat', ...x });
process.exit(0);
