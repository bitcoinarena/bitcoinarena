#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE'S OWN SLASH FLOW (spec 5A.3B, kanban #972). A private regtest, never testnet4, never a live seat. 24 nodes bond, every second on template 3, and the seats a round draws and the four holders of key 0 run as real
// `src/main.js`. A node signs two results about one run. Anyone hands that proof to one seat, and from there nothing here signs: the seat files a start, the holders replay and sign with FROST, and Bitcoin takes it. A start
// with no good proof, which only shares combined outside any seat can make, is met by the node itself: it takes its return leaf at the clock. One line per question; exits 1 if any differs.
//
//   node tools/slash-flow-regtest.mjs            (from packages/arena-node; SF_DIR, SF_BASE_PORT, BITCOIN_BIN)
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { regtest } from './regtest-bond.mjs';
import { openStore, nodeIdentity } from '../src/store.js';
import { CensusDkg } from '../src/dkg.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { censusOfView } from '../src/roster.js';
import { NEXTBLOCK, TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { RUN_82_TICKS } from './round-2of2.mjs';
import { censusKey0Shares } from '../../arena-protocol/src/census-key.js';
import { founderRun, lagrangeOf } from '../../arena-protocol/src/census-dkg.js';
import { CENSUS_KEY_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '../../arena-protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { encodeRoundContract, decodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { decodeSeatingCertificate, seatingCloseMs } from '../../arena-protocol/src/seating.js';
import { bondPresigDigest, holdClocksOf } from '../../arena-protocol/src/slash-presig.js';
import { BOND_TEMPLATE_V3, HOLD_INTERNAL_KEY, TAPLEAF_VERSION, controlBlockFor, slashStartLeaf, tapLeafHash, tapTweak } from '../../arena-protocol/src/bond-script.js';
import { tapSighash, scriptPathWitness, serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { buildSlashStart, slashStartDigest } from '../../arena-protocol/src/slash-start.js';
import { DELIVERED } from '../../arena-protocol/src/payout.js';
import { encodePlayerResult, joinSignedResult, resultId } from '../../arena-protocol/src/result.js';
import { encodeSlashProof, joinDoubleSlashEvidence, orderedResultIds, slashProofId } from '../../arena-protocol/src/slash.js';
import { readAdvertUpdate } from '../../arena-protocol/src/advert-update.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { arbitrationCommitmentIn } from '../../arena-protocol/src/arbitration-tx.js';
import { scalarTo32 } from '../../arena-protocol/src/shares.js';
import { fromHex, taggedHash, toHex } from '../../arena-protocol/src/hash.js';

const env = process.env;
const BIN = env.BITCOIN_BIN || '/mnt/bitcoin/bitcoin-31.1/bin';
const BASE = Number(env.SF_BASE_PORT || 28940), RPC = BASE, P2P = BASE + 1;
const dir = mkdtempSync(join(env.SF_DIR || '/mnt/bitcoin/relocated/claude-tmp/claude-1000', 'slash-flow-regtest-'));
const RT = join(dir, 'chain');
mkdirSync(RT); mkdirSync(join(dir, 'attach'));
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const NODES = 24, FIRST = 100000, ports = Array.from({ length: NODES }, (_, i) => BASE + 10 + i);
const stores = ports.map((_, i) => join(dir, `seat-${i + 1}.db`));
const url = (i) => `http://127.0.0.1:${ports[i]}`;
const rpcWords = ['-regtest', `-datadir=${RT}`, `-rpcport=${RPC}`];
const cli = (...a) => execFileSync(join(BIN, 'bitcoin-cli'), [...rpcWords, ...(['listwallets', 'loadwallet', 'createwallet', 'getblockcount'].includes(a[0]) ? [] : ['-rpcwallet=arena']), ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let wrong = 0;
const ask = (label, ok, said = '') => { if (!ok) wrong += 1; console.log(`#972 ${ok ? 'as expected' : 'WRONG      '} | ${label}${said === '' ? '' : ` | ${said}`}`); };
const kids = new Map();
function startSeat(i) {
  if (kids.has(i)) return;
  const log = openSync(`${stores[i]}.log`, 'a');
  kids.set(i, spawn('nice', ['-n', '15', process.execPath, 'src/main.js', String(ports[i]), stores[i]], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', log, log],
    env: { ...env, ARENA_BITCOIND_URL: `http://127.0.0.1:${RPC}`, ARENA_BITCOIND_COOKIE: `${RT}/regtest/.cookie`, ARENA_DONATION_NETWORK: 'regtest', ARENA_FUND_FREE_ROUNDS: '1',
      ARENA_CENSUS_KEY_FIRST_HEIGHT: String(FIRST), ARENA_CENSUS_KEY_0: join(dir, `key0-${i}.json`), ARENA_CENSUS_KEY_EVERY_MS: '1500', ARENA_SEATING: '1', ARENA_SEATING_TICK_MS: '1000', ARENA_ATTACH_PROOF_DIR: join(dir, 'attach'),
      ARENA_DUTY_POST: 'on', ARENA_DUTY_WALLET: 'arena', ARENA_DUTY_APPS: 'none', ARENA_SLASH_FILE_STEP_MS: '500', ARENA_BOND_CLI: [join(BIN, 'bitcoin-cli'), ...rpcWords, '-rpcwallet=arena'].join(','),
      ARENA_APPS: new URL('../../nextblock/plugin/nextblock.js', import.meta.url).pathname } }));
}
const up = async (i) => { for (let t = 0; t < 120; t++) { try { if ((await fetch(`${url(i)}/identity`, { signal: AbortSignal.timeout(3000) })).ok) return; } catch { /* not yet */ } await wait(500); } throw new Error(`seat ${i + 1} did not come up`); };
const until = async (what, fn, tries = 120, everyMs = 1000) => { let last = ''; for (let t = 0; t < tries; t++) { try { const got = await fn(); if (got) return got; } catch (e) { last = `${e.message} ${e.cause ? e.cause.message : ''}`; } await wait(everyMs); } throw new Error(`never: ${what} ${last}`); };
let done = false, mining = false;
const stopAll = async () => {
  if (done) return; done = true; mining = false;
  for (const k of kids.values()) k.kill('SIGTERM');
  await wait(2000);
  try { cli('stop'); } catch { /* gone */ }
  await wait(1500);
  if (env.SF_KEEP !== '1') rmSync(dir, { recursive: true, force: true });
};

try {
  spawn(join(BIN, 'bitcoind'), ['-regtest', `-datadir=${RT}`, `-rpcport=${RPC}`, `-port=${P2P}`, '-listen=0', '-listenonion=0', '-txindex=1', '-fallbackfee=0.0001', '-server=1'], { stdio: 'ignore', detached: false });
  for (let t = 0; t < 60; t++) { try { cli('listwallets'); break; } catch { await wait(500); } }
  try { cli('createwallet', 'arena'); } catch { /* there */ }
  const rt = regtest(cli);
  rt.mine(250);
  const ids = stores.map((s) => { const db = openStore(s); const id = nodeIdentity(db); db.close(); return id; });
  const pub = ids.map((id) => schnorr.getPublicKey(id.secret));
  const keyHex = pub.map(toHex);

  // KEY 0: four founders, each seat holding its own shares from here on
  const founders = [0, 1, 2, 3].map((i) => ({ secret: ids[i].secret, key: pub[i] }));
  const run = founderRun(censusKey0Shares({ holders: founders.map((f) => f.key), threshold: 3 }));
  const dkgs = founders.map((f) => new CensusDkg({ key: f.key, secret: f.secret, run, curve: feldmanGroup, random: (n) => new Uint8Array(randomBytes(n)) }));
  const deals = [];
  for (const d of dkgs) deals.push((await d.deal()).bytes);
  for (const d of dkgs) for (const b of deals) await d.accept(b);
  for (const d of dkgs) d.check();
  const said = dkgs.map((d) => d.statement());
  const made = dkgs.map((d) => d.finish(said));
  const key0 = made[0].groupPublicKey.subarray(1), key = toHex(key0);
  const genesis = { publicKey: key, holders: founders.map((f) => toHex(f.key)), threshold: 3 };
  for (let i = 0; i < NODES; i++) {
    const m = i < 4 ? made[i] : null;
    writeFileSync(join(dir, `key0-${i}.json`), JSON.stringify({ ...genesis, ...(m ? { held: { runId: toHex(run.runId), negated: !!m.negated, shares: [...m.shares].map(([x, v]) => [x, v.toString(16)]), commitments: m.commitments.map(toHex) } } : {}) }));
  }
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const shares = new Map();
  for (const m of made) for (const [x, v] of m.shares) shares.set(x, v);
  const xs = [...shares.keys()].sort((a, b) => a - b), lambda = lagrangeOf(xs, xs);
  const censusSecret = scalarTo32(xs.reduce((a, x) => (a + lambda.get(x) * shares.get(x)) % N, 0n));   // ONLY the false start below uses this

  const base = { networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK.gameId, simCoreHash: TRUCK_CORE_HASH, randomnessRule: 'bitcoin-block-hash',
    objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example/flow'],
    donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 0, censusRoot: new Uint8Array(32), stakeMsat: 0n, bondMinSats: 50000n, blockTicks: RUN_82_TICKS, exposureReference: 1000,
    corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, protocolVersion: CENSUS_KEY_VERSION, nodes: [] };
  const t3 = (i) => i % 2 === 0;
  const bonds = new Map();
  for (let i = 0; i < NODES; i++) {
    const p = rt.postBond(ids[i].secret, { endpoint: `ws://127.0.0.1:${ports[i]}`, bondSats: 100000n, fundBtc: '0.02', hostedGames: [NEXTBLOCK.gameId], protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS], operatorId: `op${i}`, slackBlocks: 12, ...(t3(i) ? { template: BOND_TEMPLATE_V3, censusKey: key0 } : {}) });
    rt.include([p.hex, ...(t3(i) ? [rt.postBondPresig(ids[i].secret, p).hex] : [])]);
    bonds.set(i, p);
  }
  rt.mine(3);
  const H = rt.height();
  const anchorHeaders = []; for (let h = 0; h <= H; h++) anchorHeaders.push(cli('getblockheader', cli('getblockhash', String(h)), 'false'));
  writeFileSync(join(dir, 'attach', 'headers.bin'), Buffer.from(anchorHeaders.join(''), 'hex'));
  const now0 = BigInt(Date.now());
  base.censusHeight = H;
  const shaped = decodeRoundContract(encodeRoundContract({ ...base, committeeTimeMs: now0, startTimeMs: now0 + 200000n, entryCloseMs: now0 + 200000n }));
  const standing = { network: 'regtest', standingKeys: [{ epoch: 0, publicKey: key0, height: 0 }] };
  const census = censusOfView(rt.blocksFrom(0, H), shaped, standing);
  if (!census.ok) throw new Error(`no census at ${H}: ${census.why}`);
  base.censusRoot = census.root;
  const censusAtTip = () => { const h = rt.height(); return censusOfView(rt.blocksFrom(0, h), decodeRoundContract(encodeRoundContract({ ...base, censusHeight: h, committeeTimeMs: 1n, startTimeMs: 2n, entryCloseMs: 2n })), standing); };

  mining = true;
  (async () => { while (mining) { try { rt.mine(1); } catch { /* bitcoind busy */ } await wait(2000); } })();
  startSeat(0);
  await up(0);
  const committeeTimeMs = BigInt(Date.now()) + 20000n, startTimeMs = committeeTimeMs + 320000n;
  const c = decodeRoundContract(encodeRoundContract({ ...base, committeeTimeMs, startTimeMs, entryCloseMs: startTimeMs }));
  const rid = roundId(c), ridHex = toHex(rid), body = encodeRoundContract(c);
  const post = (i) => fetch(`${url(i)}/round`, { method: 'POST', body, signal: AbortSignal.timeout(30000) }).then(async (r) => `${r.status} ${r.ok ? '' : (await r.text()).slice(0, 160)}`, (e) => `error ${e.message}`);
  const first = await post(0);
  if (!first.startsWith('2')) throw new Error(`no round: ${first}`);
  const drawn = await until('the draw', async () => { const r = await (await fetch(`${url(0)}/rounds?next=64`, { signal: AbortSignal.timeout(20000) })).json(); const row = (r.rounds || []).find((x) => x.id === ridHex); return row && row.committee && row.committee.drawn; }, 160);
  const seats = [...new Set([0, 1, 2, 3, ...[...drawn.game, ...drawn.settlement].map((k) => keyHex.indexOf(k))])];
  for (const i of seats) startSeat(i);
  for (const i of seats) await up(i);
  await Promise.all(seats.filter((i) => i !== 0).map(post));
  console.log(`#972 ${seats.length} seats up, the 4 holders among them`);
  await wait(Math.max(0, Number(seatingCloseMs(c)) - Date.now()));
  const certOf = async (i, role) => { const r = await fetch(`${url(i)}/seating?round=${ridHex}&role=${role}`, { signal: AbortSignal.timeout(8000) }).catch(() => null); return r && r.ok ? fromHex((await r.json()).cert) : null; };
  const seatedGame = await until('the game seating', async () => { for (const i of seats) { const b = await certOf(i, 'game'); if (b) return decodeSeatingCertificate(b); } return null; }, 90);
  mining = false; await wait(2500);

  // THE OFFENDER: a seated game node on template 3, not a holder
  const accused = seatedGame.seated.map((k) => keyHex.indexOf(toHex(k))).find((i) => i >= 4 && t3(i));
  if (accused === undefined) throw new Error('no template-3 seated game node outside the holders');
  const entry = census.entries.find((e) => toHex(e.pubkey) === keyHex[accused]);
  const result = (score, secret = ids[accused].secret) => { const r = { roundId: rid, playerPubkey: new Uint8Array(32).fill(0x31), outcome: DELIVERED, score, transcriptHash: new Uint8Array(32).fill(0x32), simCoreHash: TRUCK_CORE_HASH, nodePubkey: pub[accused] }; return { r, signed: joinSignedResult(encodePlayerResult(r), schnorr.sign(resultId(r), secret)) }; };
  const pairOf = (a, b) => {
    const { named, other } = orderedResultIds(resultId(a.r), resultId(b.r));
    const proof = { roundId: rid, playerPubkey: a.r.playerPubkey, nodePubkey: pub[accused], transcriptHash: other, signedResultId: named, bondTxid: entry.txid, bondVout: entry.vout };
    const [x, y] = toHex(resultId(a.r)) === toHex(named) ? [a.signed, b.signed] : [b.signed, a.signed];
    return { proof, evidence: joinDoubleSlashEvidence(encodeSlashProof(proof), x, y), id: slashProofId(proof) };
  };
  const put = (i, p) => fetch(`${url(i)}/slash/${toHex(p.id)}`, { method: 'PUT', body: p.evidence, signal: AbortSignal.timeout(8000) });
  const seen = (i) => fetch(`${url(i)}/slashes`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).then((s) => s.doubleSlashes.map((d) => d.proof));

  // WHO SIGNS WHAT: a holder's own refusals, asked directly
  const forged = pairOf(result(10), result(20, ids[accused === 4 ? 5 : 4].secret));
  const forgedAt = await put(seats.find((i) => i !== accused), forged);
  ask('a pair one of whose signatures is not the accused\'s is refused, not relayed, filed by nobody', forgedAt.status === 409 && !(await seen(seats.find((i) => i !== accused))).includes(toHex(forged.id)), (await forgedAt.text()).slice(0, 70));
  const pair = pairOf(result(10), result(20));
  const e3 = { txid: entry.txid, vout: entry.vout, value: BigInt(entry.bondSats), script: entry.script };
  const own = bondPresigDigest({ bond: e3, advert: { ...entry.advert, nodePubkey: entry.pubkey, censusKey: key0 }, networkId: NETWORK_ID_REGTEST, tweakPoint });
  const presigAt = rt.blocksFrom(entry.presigBy.height, entry.presigBy.height).blocks[0].transactions.find((t) => toHex(parseTransaction(t).txid) === toHex(entry.presigBy.txid));
  const ownPresig = readAdvertUpdate(presigAt, { network: 'regtest' }).advert.slashPresig;
  const fakeFee = { txid: new Uint8Array(32).fill(0x41), vout: 0, value: 1000n, script: fromHex(`5120${'42'.repeat(32)}`) };
  const askHolder = (i, built, evidence, presig = ownPresig) => fetch(`${url(i)}/census-sign/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ evidence: toHex(evidence), contract: toHex(body), presig: toHex(presig), tx: { version: built.tx.version, locktime: built.tx.locktime, inputs: built.tx.inputs.map((x) => ({ txid: toHex(x.txid), vout: x.vout, sequence: x.sequence })), outputs: built.tx.outputs.map((o) => ({ value: String(o.value), script: toHex(o.script) })) },
      prevouts: built.prevouts.map((o) => ({ value: String(o.value), script: toHex(o.script) })) }) }).then((r) => r.json());
  const starting = (over = {}) => buildSlashStart({ bond: e3, holdScript: own.hold.script, proofId: pair.id, slashHeight: rt.height(), fee: fakeFee, ...over });
  const f1 = await askHolder(0, starting({ proofId: forged.id }), forged.evidence);
  ask('a holder refuses a proof that fails on its own replay', f1.ok === false && /not the accused/.test(f1.why), f1.why);
  const f2 = await askHolder(0, starting({ holdScript: fromHex(`5120${'43'.repeat(32)}`) }), pair.evidence);
  ask('a holder refuses a start that pays anything but the hold its node signed', f2.ok === false && /no hold output/.test(f2.why), f2.why);
  const bentPresig = ownPresig.slice(); bentPresig[3] ^= 1;
  const f3 = await askHolder(0, starting(), pair.evidence, bentPresig);
  ask('a holder refuses a bent presig', f3.ok === false && /does not verify/.test(f3.why), f3.why);
  const f4 = await askHolder(0, starting({ proofId: taggedHash('ARENA/test/Flow', Uint8Array.of(1)) }), pair.evidence);
  ask('a holder refuses an OP_RETURN that names another proof', f4.ok === false && /does not name that proof/.test(f4.why), f4.why);
  const f5 = await askHolder(5 < NODES && seats.includes(accused) ? accused : 0, starting(), pair.evidence);
  ask('a seat that holds no share says so, after everything else held', f5.ok === false && /holds no shares/.test(f5.why), f5.why);

  // ANYONE HANDS THE PROOF TO ONE SEAT. From here no signature is made outside the seats
  const handedTo = seats.find((i) => i !== accused && i >= 4) ?? seats.find((i) => i !== accused);
  const taken = await put(handedTo, pair);
  ask('one seat takes the proof and holds it filed', taken.status === 201 && (await seen(handedTo)).includes(toHex(pair.id)), `seat ${handedTo + 1}`);
  const startedTxid = await until('the start in the mempool', async () => {
    const pool = JSON.parse(cli('getrawmempool'));
    for (const t of pool) { const raw = fromHex(cli('getrawtransaction', t)); const tx = parseTransaction(raw); if (tx.inputs.some((x) => toHex(x.previousTxid) === toHex(entry.txid) && x.previousVout === entry.vout)) return { t, tx, raw }; }
    return null;
  }, 90);
  rt.mine(1);
  const startHeight = rt.height();
  const startInfo = JSON.parse(cli('getrawtransaction', startedTxid.t, '1'));
  ask('the seat filed a start, the holders signed it, Bitcoin took it', startInfo.confirmations === 1, `${startInfo.vsize} vB`);
  ask('its witness is a real slash leaf: the node\'s presig and a BIP-340 signature of the census key', startedTxid.tx.witnesses[0].length === 4 && startedTxid.tx.witnesses[0][1].length === 65 && startedTxid.tx.witnesses[0][0].length === 64 && toHex(startedTxid.tx.witnesses[0][2]) === toHex(slashStartLeaf(pub[accused], key0)));
  const named = arbitrationCommitmentIn(startedTxid.tx.outputs);
  ask('its OP_RETURN names the proof, and the proof is fetched by that id', toHex(named.proofId) === toHex(pair.id) && (await fetch(`${url(handedTo)}/slash/${toHex(pair.id)}`)).ok);
  const after = censusAtTip();
  ask('its hold output stays the bond in the census', !!after.entries.find((e) => toHex(e.txid) === toHex(entry.txid) && e.hold));
  await wait(4000);
  ask('one start: no second filer spent anything on it', JSON.parse(cli('getrawmempool')).length === 0);

  // THE ACCUSED READS IT, AND A TRUE PROOF IS NOT A WAY OUT
  const clocks = holdClocksOf(NETWORK_ID_REGTEST);
  const read = await until('the accused reads its start', async () => { const b = await (await fetch(`${url(accused)}/owner/bond`, { signal: AbortSignal.timeout(8000) })).json(); return b.started ? b.started[0] : null; }, 60);
  ask('the accused reads a hold it signed', read.known === true && read.startTxid === startedTxid.t && read.startHeight === startHeight, `release at ${read.releaseOpensAt ?? '-'}, return at ${read.returnOpensAt}, fallback at ${read.fallbackOpensAt}`);

  // A START WITH NO GOOD PROOF. This needs the census key's secret, which no seat has: 2/3 of the shares combined, in this harness. A running template-3 node is the target, and it is left to itself
  const target = seats.find((i) => i !== accused && i >= 4 && t3(i)) ?? seats.find((i) => i !== accused && t3(i));
  const te = census.entries.find((e) => toHex(e.pubkey) === keyHex[target]);
  const t3b = { txid: te.txid, vout: te.vout, value: BigInt(te.bondSats), script: te.script };
  const tOwn = bondPresigDigest({ bond: t3b, advert: { ...te.advert, nodePubkey: te.pubkey, censusKey: key0 }, networkId: NETWORK_ID_REGTEST, tweakPoint });
  const tRaw = rt.blocksFrom(te.presigBy.height, te.presigBy.height).blocks[0].transactions.find((t) => toHex(parseTransaction(t).txid) === toHex(te.presigBy.txid));
  const tPresig = readAdvertUpdate(tRaw, { network: 'regtest' }).advert.slashPresig;
  const payer = schnorr.utils.randomSecretKey(), feeLeaf = Uint8Array.from([0x20, ...schnorr.getPublicKey(payer), 0xac]);
  const q = tweakPoint(HOLD_INTERNAL_KEY, tapTweak(HOLD_INTERNAL_KEY, tapLeafHash(feeLeaf)));
  const feeScript = fromHex(`5120${toHex(q.outputKey)}`), feeCoin = rt.fund(feeScript, '0.00001');
  rt.mine(1);
  const nobody = taggedHash('ARENA/test/FlowNobodysProof', Uint8Array.of(9));
  const falseStart = buildSlashStart({ bond: t3b, holdScript: tOwn.hold.script, proofId: nobody, slashHeight: rt.height(), fee: { txid: fromHex(feeCoin.txid).reverse(), vout: feeCoin.vout, value: feeCoin.value, script: feeScript } });
  const digest = slashStartDigest({ tx: falseStart.tx, prevouts: falseStart.prevouts, nodeKey: te.pubkey, censusKey: key0 });
  const built = bonds.get(target).built;
  const falseTx = cli('sendrawtransaction', toHex(serializeSpend({ ...falseStart.tx, witnesses: [
    scriptPathWitness({ stack: [schnorr.sign(digest, censusSecret), tPresig], script: slashStartLeaf(te.pubkey, key0), controlBlock: controlBlockFor('slash', built).controlBlock }),
    scriptPathWitness({ stack: [schnorr.sign(tapSighash({ ...falseStart.tx, prevouts: falseStart.prevouts, inputIndex: 1, leafHash: tapLeafHash(feeLeaf) }), payer)], script: feeLeaf, controlBlock: Uint8Array.from([TAPLEAF_VERSION | q.parity, ...HOLD_INTERNAL_KEY]) }),
  ] })));
  rt.mine(1);
  const falseHeight = rt.height();
  ask('a false start is mined: shares combined outside any seat can do that', JSON.parse(cli('getrawtransaction', falseTx, '1')).confirmations === 1);
  const tRead = await until('the target reads its start', async () => { const b = await (await fetch(`${url(target)}/owner/bond`, { signal: AbortSignal.timeout(8000) })).json(); return b.started ? b.started[0] : null; }, 60);
  ask('the target reads it, the proof it names nobody can fetch', tRead.known === true && tRead.proofId === toHex(nobody), `return at ${tRead.returnOpensAt}`);
  const opens = Math.max(tRead.returnOpensAt, read.returnOpensAt);
  rt.mine(Math.max(0, tRead.returnOpensAt - 1 - rt.height()));
  await wait(5000);
  ask('the hold is unspent a block before the clock', cli('gettxout', falseTx, '0') !== '');
  rt.mine(Math.max(1, opens - rt.height()));
  const returned = await until('the target\'s own return', async () => { const pool = JSON.parse(cli('getrawmempool')); for (const t of pool) { const d = JSON.parse(cli('getrawtransaction', t, '1')); if (d.vin[0].txid === falseTx) return { t, d }; } return null; }, 60);
  rt.mine(1);
  const paidTo = returned.d.vout[0];
  ask('the node took its return leaf by itself, with nobody asking', JSON.parse(cli('getrawtransaction', returned.t, '1')).confirmations === 1, `${returned.d.vsize} vB, ${falseHeight} + ${rt.height() - 1 - falseHeight} blocks`);
  ask('the money is in its bond wallet', JSON.parse(cli('getaddressinfo', paidTo.scriptPubKey.address)).ismine === true, `${Math.round(paidTo.value * 1e8)} of ${te.bondSats} sat`);
  ask('the hold output left the census, by its return', !censusAtTip().entries.find((e) => toHex(e.txid) === toHex(te.txid)));
  // ITS PASS RUNS EVERY 1.5 s, and its clock opened no later than the target's: give it several, and any return a block to land in
  await wait(9000);
  ask('nothing is waiting in the mempool', JSON.parse(cli('getrawmempool')).length === 0);
  rt.mine(1);
  ask('the accused, whose proof is true, stayed: no return at the same height', cli('gettxout', startedTxid.t, '0') !== '', 'its hold is unspent past the return clock');
  ask('and it still counts', !!censusAtTip().entries.find((e) => toHex(e.txid) === toHex(entry.txid) && e.hold));
  console.log(`#972 clocks ${clocks.holdBlocks} / ${clocks.returnBlocks} / ${clocks.fallbackBlocks}, the true start's hold left for a release or the fallback`);
} catch (e) { wrong += 1; console.error(`#972 stopped: ${e.stack}`); console.error(`#972 logs in ${dir}`); env.SF_KEEP = '1'; }
if (wrong) { env.SF_KEEP = '1'; console.error(`#972 logs in ${dir}`); }
await stopAll();
console.log(wrong ? `#972 ${wrong} wrong` : '#972 all as expected');
process.exit(wrong ? 1 : 0);
