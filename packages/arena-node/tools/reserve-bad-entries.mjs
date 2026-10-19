// reserve-bad-entries.mjs (kanban #397 slice 1, the fail measurement): three entries a version-11 round must refuse, sent to its seats
// on testnet4 - the protocol reserves' rules as the seats hold them live.
//   v10way       an entry that pays the old way on a v11 round: fee 4,000 msat, donation 4,000 (the developers' part only), no
//                reserve lock. Expected at /entry: 409 "... are 6000 msat, not 4000"; nothing kept (GET /entry answers no entry).
//   reserve1999  a real lock transaction - stake, fee lock, the developers' outputs and a reserve output of 1,999 msat to the reserve
//                key - and an entry that names it and claims the right 6,000 msat. Expected at /lock: 409 "... is not 2000 msat to key
//                ..."; no reserve row on any seat.
//   otherkey     the same with 2,000 msat to a key that is not the federation's reserve key. Expected: the same refusal.
//   right        the same lock with the reserve output right - 2,000 msat to the reserve key (the page's protocol-11 entry, kanban #397:
//                the headless tn4-live-run.mjs builds the pre-11 split and every seat refused it, "the node fee is 4000 msat (4 %), not
//                5000"). Expected: the entry and its lock taken on the seats, and the federation's held reserves 2,000 msat higher.
// The round: ROUND, else the next version-11 nextblock round of federation B open for entries and starting 75 s ahead.
// env: NODES (all 14 seat URLs), INVITE_FILE (federation B), WASM_PKG, LNCLI, PAYER_DIR, PAYER_RPC, GATEWAY, CASES (default the three refusals)
import { readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { feldmanGroup } from '../src/curve.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { attestedClaimKey } from '../../arena-client/src/join.js';
import { pageCurve } from '../../arena-client/src/page-curve.js';
import { donationKeyShares } from '../../arena-client/src/page-lock.js';
import { decodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { feeLockPays } from '../../arena-protocol/src/lock-settlement.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { worldIsShared } from '../../arena-protocol/src/seed.js';
import { sharedWorldOf } from '../../arena-protocol/src/known-game.js';
import { roundSplit } from '../../arena-protocol/src/reserves.js';
import { RESERVES_VERSION } from '../../arena-protocol/src/constants.js';
import { decodeDonationSet } from '../../arena-protocol/src/donation.js';
import { decodeDonationSetBody } from '../../arena-protocol/src/authority.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';

const env = process.env;
for (const k of ['NODES', 'INVITE_FILE', 'WASM_PKG', 'LNCLI', 'PAYER_DIR', 'PAYER_RPC']) if (!env[k]) { console.error(`${k} is needed`); process.exit(2); }
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const rand = (n) => new Uint8Array(randomBytes(n));
const run = (bin, args) => new Promise((done) => execFile(bin, args, { timeout: 240000 }, (err, out, errOut) => done({ ok: !err, out: String(out), err: String(errOut || (err && err.message) || '') })));
const payer = (...a) => run(env.LNCLI, [`--lnddir=${env.PAYER_DIR}`, `--rpcserver=${env.PAYER_RPC}`, '--network=testnet4', ...a]);
const scalar = () => { for (;;) { const s = rand(32); const v = scalarFrom32(s); if (v > 0n && v < FIELD) return s; } };
const evenPlayer = () => { let k; do { k = secp256k1.utils.randomSecretKey(); } while (secp256k1.getPublicKey(k, true)[0] !== 0x02); return schnorr.getPublicKey(k); };
const nodes = env.NODES.split(',').map((u) => u.trim().replace(/\/+$/, ''));
const cases = (env.CASES || 'v10way,reserve1999,otherkey').split(',');
const FED_B = 'b18947f0';

try {
  // THE ROUND: a version-11 nextblock round of federation B, open for entries
  if (!env.ROUND) {
    const list = (await (await fetch(`${nodes[0]}/rounds`)).json()).rounds;
    const now = Date.now();
    const pick = [];
    for (const x of list.filter((y) => y.entryOpen && y.game && y.game.name === 'nextblock' && String(y.federation).startsWith(FED_B) && Number(y.startTimeMs) - now > 75000)) {
      const b = await fetch(`${nodes[0]}/round?id=${x.id}`); if (!b.ok) continue;
      const c = decodeRoundContract(new Uint8Array(await b.arrayBuffer()));
      if (Number(c.protocolVersion) >= RESERVES_VERSION) pick.push(x);
    }
    pick.sort((a, b) => Number(a.startTimeMs) - Number(b.startTimeMs));
    if (!pick.length) throw new Error(`no version-${RESERVES_VERSION} nextblock round of federation ${FED_B} is open for entries: the Tick Tock posting is not at protocol 11 yet`);
    env.ROUND = pick[0].id;
  }
  const c = decodeRoundContract(new Uint8Array(await (await fetch(`${nodes[0]}/round?id=${env.ROUND}`)).arrayBuffer()));
  const rid = roundId(c);
  if (Number(c.protocolVersion) < RESERVES_VERSION) throw new Error(`round ${env.ROUND.slice(0, 16)} is version ${c.protocolVersion}, not ${RESERVES_VERSION}`);
  const STAKE = BigInt(c.stakeMsat);
  const split = roundSplit(STAKE);
  const FEE = split.nodesMsat, DEVS = split.protocolDevsMsat + split.gameDevsMsat, RES = split.reservesMsat;
  log({ step: 'round', id: env.ROUND.slice(0, 16), version: c.protocolVersion, stakeMsat: STAKE, feeMsat: FEE, devsMsat: DEVS, reservesMsat: RES, federation: toHex(c.federationId).slice(0, 16) });

  // THE FEDERATION'S RESERVE KEY, as five seats name it; the round's two donation sets
  const said = new Map();
  await Promise.all(nodes.map(async (n) => { try { const f = ((await (await fetch(`${n}/reserves`)).json()).federations || []).find((x) => x.federationId === toHex(c.federationId) && (x.key || x.reserveKey));
    if (f) said.set(f.key || f.reserveKey, (said.get(f.key || f.reserveKey) || 0) + 1); } catch { /* none */ } }));
  const best = [...said.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] < 5) throw new Error('fewer than five seats name the federation\'s reserve key');
  const reserveKey = fromHex(best[0]);
  const netBytes = new Uint8Array(await (await fetch(`${nodes[0]}/donation-set?round=${env.ROUND}`)).arrayBuffer());
  const network = decodeDonationSetBody(netBytes.subarray(0, netBytes.length - 64)).recipients;
  const game = decodeDonationSet(new Uint8Array(await (await fetch(`${nodes[0]}/game-donation-set?round=${env.ROUND}`)).arrayBuffer()));
  log({ step: 'reserve key', key: best[0], agreeing: best[1], sets: [network.length, game.length] });

  // THE ROUND'S SIGNER NODES' CLAIM KEY
  const att = await attestedClaimKey({ round: { ...c, id: rid }, signerNodes: c.nodes, nodes, curve: pageCurve });
  if (!att.ok) throw new Error(`claim key: ${att.why}`);
  const heldBefore = await reservesOf(toHex(c.federationId));
  log({ step: 'reserves before', held: heldBefore });

  // A PLAYER'S STAKE SECRET AND ITS HANDOUT, then the entry naming the lock outputs `lockOuts` (or zero outpoints)
  const prepare = async () => {
    const s = { p: scalar(), player: evenPlayer() };
    const needed = receiptsNeeded(c.nodes.length);
    const e = rand(32);
    const dealt = await dealHandout({ preimage: s.p, signerNodes: c.nodes, roundId: rid, playerPubkey: s.player, ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
      coefficients: Array.from({ length: needed - 1 }, () => scalarFrom32(rand(32)) % FIELD), needed, curve: feldmanGroup });
    return { s, dealt };
  };
  const makeEntry = async ({ donationMsat, lockOuts = null, prep = null }) => {
    const { s, dealt } = prep || await prepare();
    const zero = { txid: new Uint8Array(32), outIdx: 0n };
    const entry = { roundId: rid, playerPubkey: s.player, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()), stakeCommitment: sha256(s.p), stakeMsat: STAKE,
      feeMsat: FEE, donationMsat, joinTick: 0, worldSecret: worldIsShared(c, sharedWorldOf(c.gameId)) ? new Uint8Array(32) : rand(32), vssSharesRef: handoutId(dealt.handout),
      stakePoint: dealt.handout.commitments[0], feePreimage: lockOuts && lockOuts.feePreimage ? lockOuts.feePreimage : new Uint8Array(32),
      stakeLockOutpoint: lockOuts ? lockOuts.stake.outpoint : zero, feeLockOutpoint: lockOuts && lockOuts.fee ? lockOuts.fee.outpoint : zero, claimKeyAttestationRef: att.ref,
      ...(lockOuts ? { donationOutpoints: lockOuts.devs.map((d) => d.outpoint), reserveOutpoint: lockOuts.reserve.outpoint } : {}) };
    return { s, dealt, entry, eid: entryId(entry) };
  };
  const hand = async (made, lockOuts = null) => {
    const out = [];
    for (const n of nodes) {
      const h = await fetch(`${n}/handout`, { method: 'POST', body: encodeHandout(made.dealt.handout) }).catch(() => null);
      const en = await fetch(`${n}/entry`, { method: 'POST', body: encodeEntryContract(made.entry) }).catch((x) => ({ status: 0, text: async () => x.message }));
      const row = { node: n.replace(/^https?:\/\//, ''), handout: h ? h.status : 0, entry: en.status, entrySaid: (await en.text()).trim().slice(0, 140) };
      if (lockOuts) {
        if (lockOuts.fee) await fetch(`${n}/fee-lock?entry=${toHex(made.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(lockOuts.fee.fields)) }).catch(() => null);
        const l = await fetch(`${n}/lock?entry=${toHex(made.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(lockOuts.stake.fields)) }).catch((x) => ({ status: 0, text: async () => x.message }));
        row.lock = l.status; row.lockSaid = (await l.text()).trim().slice(0, 160);
      }
      out.push(row);
    }
    return out;
  };

  // CASE 1: THE OLD WAY ON A NEW ROUND - nothing paid
  if (cases.includes('v10way')) {
    const made = await makeEntry({ donationMsat: DEVS });
    const seats = await hand(made);
    const kept = await Promise.all(nodes.map(async (n) => (await fetch(`${n}/entry?id=${toHex(made.eid)}`).catch(() => ({ status: 0 }))).status));
    log({ step: 'case v10way', entry: toHex(made.eid).slice(0, 16), refused409: seats.filter((x) => x.entry === 409).length, of: seats.length,
      said: [...new Set(seats.map((x) => x.entrySaid))], keptAnywhere: kept.filter((x) => x === 200).length });
  }

  // CASES 2 AND 3: A REAL LOCK WITH A WRONG RESERVE OUTPUT - AND 'right', THE SAME LOCK WITH IT RIGHT
  const wrong = cases.filter((x) => x === 'reserve1999' || x === 'otherkey' || x === 'right');
  if (wrong.length) {
    if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
    const esm = join(tmpdir(), `blwp-lock-client-${process.pid}.mjs`); copyFileSync(`${env.WASM_PKG}/blwp_lock_client.js`, esm);
    const wasmMod = await import(esm); await wasmMod.default({ module_or_path: readFileSync(`${env.WASM_PKG}/blwp_lock_client_bg.wasm`) });
    const { LockClient } = wasmMod;
    const invite = readFileSync(env.INVITE_FILE, 'utf8').replace(/["\s]/g, '');
    if (!toHex(c.federationId).startsWith(LockClient.federationIdOf(invite).slice(0, 8))) throw new Error('INVITE_FILE is not the round\'s federation');
    const held = new Map();
    const lc = await LockClient.join(invite, LockClient.federationIdOf(invite), toHex(rand(32)), { entries: () => JSON.stringify([...held]), put: (k, v) => { held.set(k, v); }, remove: (k) => { held.delete(k); } });
    const rule = JSON.parse(await lc.feeRule());
    const gate = feeLockPays({ contract: c, fees: { ppm: BigInt(rule.fee_ppm), baseMsat: BigInt(rule.fee_base_msat) } });
    const depositMsat = BigInt(wrong.length) * (STAKE + 100000n) + 200000n;
    const rcv = JSON.parse(await lc.receive(String(depositMsat), env.GATEWAY || 'https://cleaner-cindy-duty-biggest.trycloudflare.com/'));
    const paid = await payer('payinvoice', '--force', '--timeout', '90s', rcv.invoice);
    log({ step: 'deposit', msat: depositMsat, paid: (paid.out.match(/Payment status: [A-Z_]+/) || [paid.err.slice(0, 120)])[0], final: await lc.awaitReceive(rcv.operation), balanceMsat: await lc.balanceMsat() });
    for (const which of wrong) {
      const reserve = which === 'reserve1999' ? { recipientPk: reserveKey, amountMsat: RES - 1n }
        : which === 'right' ? { recipientPk: reserveKey, amountMsat: RES } : { recipientPk: secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true), amountMsat: RES };   // a real point (0x02 + 32 random bytes is often none: "malformed public key")
      // the developers' part right, the reserve output wrong - and the entry claims the right 6,000 msat
      const shares = donationKeyShares(DEVS + reserve.amountMsat, { network, game, reserve });
      const prep = await prepare();
      const stakePoint = prep.dealt.handout.commitments[0], player = prep.s.player;
      const net = netStakeMsat({ stakeMsat: STAKE, feeMsat: FEE, donationMsat: DEVS + RES });
      const F = gate.pays ? rand(32) : null;
      const refundPk = refundKeyOf(player);
      const sub = JSON.parse(await lc.lockSubmit(toHex(stakePoint), String(net), F ? toHex(sha256(F)) : '', String(gate.pays ? FEE : 0n), toHex(att.claimPk), toHex(refundPk),
        Number(c.stakeExpiryBlocks), JSON.stringify(shares.map((d) => ({ pk: toHex(d.recipientPk), msat: String(d.amountMsat), image: toHex(player) })))));
      const outs = sub.outputs || [];
      const at = (o) => ({ txid: fromHex(sub.txid), outIdx: BigInt(o.out_idx) });
      const so = outs.find((o) => o.role === 'stake'), fo = outs.find((o) => o.role === 'fee');
      const dons = outs.filter((o) => o.role === 'donation');
      const lockOuts = { stake: { outpoint: at(so), fields: { paymentImage: { kind: 'point', bytes: stakePoint }, amountMsat: BigInt(so.amount_msat), claimPk: att.claimPk, refundPk, expiration: so.computed_expiration } },
        fee: fo ? { outpoint: at(fo), fields: { paymentImage: { kind: 'hash', bytes: sha256(F) }, amountMsat: BigInt(fo.amount_msat), claimPk: att.claimPk, refundPk, expiration: fo.computed_expiration } } : null,
        feePreimage: F, devs: dons.slice(0, -1).map((o) => ({ outpoint: at(o) })), reserve: { outpoint: at(dons[dons.length - 1]) } };
      await lc.lockAccepted(JSON.stringify(sub));
      // the entry - the same player and stake - names the lock's outputs, and claims the right 6,000 msat
      const named = await makeEntry({ donationMsat: DEVS + RES, lockOuts, prep });
      const seats = await hand(named, lockOuts);
      log({ step: `case ${which}`, tx: sub.txid.slice(0, 16), reserveOutput: `${reserve.amountMsat} msat to ${toHex(reserve.recipientPk).slice(0, 16)}`, entry: toHex(named.eid).slice(0, 16),
        entryAccepted: seats.filter((x) => x.entry >= 200 && x.entry < 300).length, lockRefused409: seats.filter((x) => x.lock === 409).length, lockTaken: seats.filter((x) => x.lock >= 200 && x.lock < 300).length,
        of: seats.length, said: [...new Set(seats.map((x) => x.lockSaid))].slice(0, 3) });
    }
  }
  // NO RESERVE ROW FROM ANY OF THEM: the federation's held reserves, the same on every seat, unchanged
  await new Promise((ok) => setTimeout(ok, 5000));
  log({ step: 'reserves after', held: await reservesOf(toHex(c.federationId)), before: heldBefore });
} catch (e) { log({ step: 'stopped', why: String(e.stack || e.message).slice(0, 600) }); process.exitCode = 1; }

async function reservesOf(fedHex) {
  const all = await Promise.all(nodes.map(async (n) => { try { const f = ((await (await fetch(`${n}/reserves`)).json()).federations || []).find((x) => x.federationId === fedHex); return f ? f.heldMsat : null; } catch { return null; } }));
  return [...new Set(all.map(String))].join(' / ') + ` (${all.filter((x) => x !== null).length} seats)`;
}
