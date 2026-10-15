// item-pay-test.mjs (kanban #365 step 3): one in-game item bought for real on testnet4 - a fresh wasm wallet in the federation,
// funded over Lightning from lnd-testnet4, pays the 500 sat split (purchaseOutputs: 12 served nodes from every seat's merged
// FINALs, the network's and the game's donation sets) with the lock client's paySubmit, its acceptance read back output by
// output (lockAccepted), the buyer's record signed and checked (purchaseStands).
// env: SEATS (comma list of seat urls), ROUND (a round id whose sets to read), INVITE_FILE, WASM_PKG, LNCLI, PAYER_DIR, PAYER_RPC, GATEWAY
import { readFileSync, copyFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { servedNodes, mergeServedRounds, SERVED_WINDOW_MS } from '../../arena-protocol/src/served-nodes.js';
import { purchaseOutputs, purchaseId, purchaseStands } from '../../arena-protocol/src/purchase.js';
import { decodeDonationSet } from '../../arena-protocol/src/donation.js';
import { decodeDonationSetBody } from '../../arena-protocol/src/authority.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { ITEMS_VERSION } from '../../arena-protocol/src/constants.js';
const env = process.env;
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const run = (bin, args) => new Promise((ok) => execFile(bin, args, { timeout: 180000 }, (e, out, err) => ok({ code: e ? e.code || 1 : 0, out: String(out), err: String(err) })));
const payer = (...a) => run(env.LNCLI, [`--lnddir=${env.PAYER_DIR}`, `--rpcserver=${env.PAYER_RPC}`, '--network=testnet4', ...a]);
const seats = env.SEATS.split(',');
const get = async (u, kind = 'json') => { const r = await fetch(u, { signal: AbortSignal.timeout(30000) }); if (!r.ok) throw new Error(`${u}: ${r.status}`); return kind === 'json' ? r.json() : new Uint8Array(await r.arrayBuffer()); };

// 1. THE TWO DONATION SETS, as a seat serves them for a round of the game
const netBytes = await get(`${seats[0]}/donation-set?round=${env.ROUND}`, 'bytes');
const networkSet = decodeDonationSetBody(netBytes.subarray(0, netBytes.length - 64)).recipients;
const gameSet = decodeDonationSet(await get(`${seats[0]}/game-donation-set?round=${env.ROUND}`, 'bytes'));
log({ step: 'sets', network: networkSet.map((r) => [r.label, r.shareBps]), game: gameSet.map((r) => [r.label, r.shareBps]) });

// 2. WHO SERVED IN THE 24 H BEFORE NOW, from every seat's FINALs
const toMs = BigInt(Date.now() - 60000), fromMs = toMs - BigInt(SERVED_WINDOW_MS);
const held = [];
for (const s of seats) { try { const a = await get(`${s}/served?to=${toMs}&finals=1`); held.push((a.held || []).map((r) => ({ roundId: fromHex(r.roundId), committee: r.committee.map(fromHex), finals: r.finals.map(fromHex) }))); } catch (e) { log({ step: 'seat', seat: s, why: e.message }); } }
const served = servedNodes({ rounds: mergeServedRounds(held).rounds, fromMs, toMs, verify: (sg, m, k) => schnorr.verify(sg, m, k) });
log({ step: 'served', seats: held.length, rounds: served.rounds, nodes: served.nodes.length, root: served.root });

// 3. THE SPLIT OF 500 SAT
const { outputs, split } = purchaseOutputs({ priceSat: 500n, servedKeys: served.nodes.map((n) => n.key), networkSet, gameSet });
log({ step: 'split', outputs: outputs.length, perNodeMsat: split.perNodeMsat, protocolMsat: split.protocolMsat, gameMsat: split.gameMsat, sum: outputs.reduce((t, o) => t + o.msat, 0n) });

// 4. A FRESH WALLET, FUNDED OVER LIGHTNING
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const esm = join(tmpdir(), `item-pay-${process.pid}.mjs`); copyFileSync(join(env.WASM_PKG, 'blwp_lock_client.js'), esm);
const m = await import(esm); await m.default({ module_or_path: readFileSync(join(env.WASM_PKG, 'blwp_lock_client_bg.wasm')) });
const invite = readFileSync(env.INVITE_FILE, 'utf8').trim();
const kept = new Map();
const lc = await m.LockClient.join(invite, m.LockClient.federationIdOf(invite), toHex(randomBytes(32)), { entries: () => JSON.stringify([...kept]), put: (k, v) => { kept.set(k, v); }, remove: (k) => { kept.delete(k); } });
const rcv = JSON.parse(await lc.receive(String(700000n), env.GATEWAY));
const paid = await payer('payinvoice', '--force', '--timeout', '90s', rcv.invoice);
const final = await lc.awaitReceive(rcv.operation);
log({ step: 'deposit', paid: (paid.out.match(/Payment status: [A-Z_]+/) || [paid.err.slice(0, 160)])[0], final, balanceMsat: await lc.balanceMsat() });

// 5. THE PAYMENT: paySubmit, then lockAccepted
const buyerSecret = randomBytes(32), buyer = schnorr.getPublicKey(buyerSecret);
const t0 = Date.now();
const submitted = JSON.parse(await lc.paySubmit(JSON.stringify(outputs.map((o) => ({ pk: toHex(o.pk), msat: String(o.msat), image: toHex(buyer) })))));
const t1 = Date.now();
const accepted = JSON.parse(await lc.lockAccepted(JSON.stringify(submitted)));
const t2 = Date.now();
const outs = accepted.donations || [];
log({ step: 'paid', txid: submitted.txid, submitMs: t1 - t0, acceptMs: t2 - t1, outputs: outs.length, idsMatch: outs.every((d) => d.ids_match),
  sum: outs.reduce((t, d) => t + BigInt(d.amount_msat), 0n), balanceMsat: await lc.balanceMsat() });

// 6. THE BUYER'S RECORD, signed and checked as any node checks it
const manifest = { gameDevPubkey: new Uint8Array(32).fill(0xde), gameName: 'nextblock', items: [{ id: 'large-truck', name: 'Larger truck', priceSat: 500n, unlock: new Uint8Array(32).fill(0xa1) }], requiredProtocolVersion: ITEMS_VERSION };
const rec = { gameDevPubkey: manifest.gameDevPubkey, gameName: 'nextblock', itemId: 'large-truck', priceSat: 500n, playerPubkey: buyer, federationId: fromHex(m.LockClient.federationIdOf(invite)),
  txid: fromHex(submitted.txid), servedFromMs: fromMs, servedToMs: toMs, servedRoot: fromHex(served.root),
  outputs: outs.map((d) => ({ outIdx: Number(d.out_idx), pk: fromHex(d.recipient_pk), msat: BigInt(d.amount_msat) })), boughtAtMs: BigInt(Date.now()) };
rec.signature = schnorr.sign(purchaseId(rec), buyerSecret);
const st = purchaseStands(rec, { manifest, networkSet, gameSet, served: { fromMs, toMs, nodes: served.nodes, root: served.root }, verify: (sg, msg, k) => schnorr.verify(sg, msg, k) });
log({ step: 'record', stands: st.ok, why: st.why || null, purchase: st.ok ? toHex(st.id) : null });
process.exit(0);
