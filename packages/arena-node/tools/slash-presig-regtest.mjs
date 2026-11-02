#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// slash_presig THROUGH THE NODE'S OWN CODE (spec 5A.3B, kanban #972). A private regtest, never testnet4, never a live seat. 24 nodes bond, part of them on template 3 naming key 0, and one with
// two such bonds. The round's drawn seats run as real `src/main.js`, seat themselves, and hand their presigs with their seating signatures. Then Bitcoin is the judge: a presig off a seat's
// door, the census key beside it and the proof's OP_RETURN spend a bond into the hold output that door's panels rebuild, and those panels release it. One line per question; exits 1 if any differs.
//
//   node tools/slash-presig-regtest.mjs            (from packages/arena-node; SP_DIR, SP_BASE_PORT, BITCOIN_BIN)
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
import { decodeSeatingCertificate, encodeSeatingCertificate, seatingCloseMs } from '../../arena-protocol/src/seating.js';
import { bondPresigDigest, holdClocksOf, slashPresigDigest, slashPresigVerifies, SLASH_START_SEQUENCE } from '../../arena-protocol/src/slash-presig.js';
import { BOND_TEMPLATE_V3, HOLD_INTERNAL_KEY, TAPLEAF_VERSION, controlBlockFor, holdControlBlock, holdOutputKey, slashStartLeaf, tapLeafHash, tapTweak } from '../../arena-protocol/src/bond-script.js';
import { tapSighash, scriptPathWitness, serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { readAdvertUpdate } from '../../arena-protocol/src/advert-update.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { arbitrationCommitment } from '../../arena-protocol/src/arbitration-tx.js';
import { scalarTo32 } from '../../arena-protocol/src/shares.js';
import { fromHex, taggedHash, toHex } from '../../arena-protocol/src/hash.js';

const env = process.env;
const BIN = env.BITCOIN_BIN || '/mnt/bitcoin/bitcoin-31.1/bin';
const BASE = Number(env.SP_BASE_PORT || 28740), RPC = BASE, P2P = BASE + 1;
const dir = mkdtempSync(join(env.SP_DIR || '/mnt/bitcoin/relocated/claude-tmp/claude-1000', 'slash-presig-regtest-'));
const RT = join(dir, 'chain');
mkdirSync(RT); mkdirSync(join(dir, 'attach'));
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const NODES = 24, FIRST = 100000, ports = Array.from({ length: NODES }, (_, i) => BASE + 10 + i);
const stores = ports.map((_, i) => join(dir, `seat-${i + 1}.db`));
const url = (i) => `http://127.0.0.1:${ports[i]}`;
const cli = (...a) => execFileSync(join(BIN, 'bitcoin-cli'), ['-regtest', `-datadir=${RT}`, `-rpcport=${RPC}`,
  ...(['listwallets', 'loadwallet', 'createwallet', 'getblockcount'].includes(a[0]) ? [] : ['-rpcwallet=arena']), ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };

let wrong = 0;
const ask = (label, ok, said = '') => { if (!ok) wrong += 1; console.log(`#972 ${ok ? 'as expected' : 'WRONG      '} | ${label}${said === '' ? '' : ` | ${said}`}`); };
const kids = new Map();
function startSeat(i) {
  if (kids.has(i)) return;
  const log = openSync(`${stores[i]}.log`, 'a');
  kids.set(i, spawn('nice', ['-n', '15', process.execPath, 'src/main.js', String(ports[i]), stores[i]], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', log, log],
    env: { ...env, ARENA_BITCOIND_URL: `http://127.0.0.1:${RPC}`, ARENA_BITCOIND_COOKIE: `${RT}/regtest/.cookie`, ARENA_DONATION_NETWORK: 'regtest', ARENA_FUND_FREE_ROUNDS: '1',
      ARENA_CENSUS_KEY_FIRST_HEIGHT: String(FIRST), ARENA_CENSUS_KEY_0: join(dir, `key0-${i}.json`), ARENA_SEATING: '1', ARENA_SEATING_TICK_MS: '1000', ARENA_ATTACH_PROOF_DIR: join(dir, 'attach'),
      ARENA_APPS: new URL('../../nextblock/plugin/nextblock.js', import.meta.url).pathname } }));
}
const up = async (i) => { for (let t = 0; t < 120; t++) { try { if ((await fetch(`${url(i)}/identity`, { signal: AbortSignal.timeout(3000) })).ok) return; } catch { /* not yet */ } await wait(500); } throw new Error(`seat ${i + 1} did not come up`); };
let done = false, mining = false;
const stopAll = async () => {
  if (done) return; done = true; mining = false;
  for (const k of kids.values()) k.kill('SIGTERM');
  await wait(2000);
  try { cli('stop'); } catch { /* gone */ }
  await wait(1500);
  if (env.SP_KEEP !== '1') rmSync(dir, { recursive: true, force: true });
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

  // KEY 0, made before any bond by four founders in one process: the census key this run needs, and nothing else about it is under test here
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
  for (let i = 0; i < NODES; i++) writeFileSync(join(dir, `key0-${i}.json`), JSON.stringify(genesis));
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const shares = new Map();
  for (const m of made) for (const [x, v] of m.shares) shares.set(x, v);
  const xs = [...shares.keys()].sort((a, b) => a - b), lambda = lagrangeOf(xs, xs);
  const censusSecret = scalarTo32(xs.reduce((a, x) => (a + lambda.get(x) * shares.get(x)) % N, 0n));
  ask('key 0 stands in for the census key, and these shares sign for it', toHex(schnorr.getPublicKey(censusSecret)) === key);

  const base = { networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK.gameId, simCoreHash: TRUCK_CORE_HASH, randomnessRule: 'bitcoin-block-hash',
    objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example/presig'],
    donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 0, censusRoot: new Uint8Array(32), stakeMsat: 0n, bondMinSats: 50000n, blockTicks: RUN_82_TICKS, exposureReference: 1000,
    corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, protocolVersion: CENSUS_KEY_VERSION, nodes: [] };
  // THE BONDS: every second node on template 3, node 0 with two such outputs, the rest on template 2
  const bond = (i, sats, extra = {}) => rt.postBond(ids[i].secret, { endpoint: `ws://127.0.0.1:${ports[i]}`, bondSats: sats, fundBtc: '0.02', hostedGames: [NEXTBLOCK.gameId], protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS], operatorId: `op${i}`, ...extra });
  const t3 = (i) => i % 2 === 0;
  const bonds = new Map();
  const postOne = (i, extra = {}, { presig = true } = {}) => { const p = bond(i, 100000n, t3(i) ? { template: BOND_TEMPLATE_V3, censusKey: key0, ...extra } : extra); rt.include([p.hex, ...(t3(i) && presig ? [rt.postBondPresig(ids[i].secret, p).hex] : [])]); (bonds.get(i) || bonds.set(i, []).get(i)).push(p); return p; };
  for (let i = 0; i < NODES; i++) postOne(i);
  postOne(0);
  // A TEMPLATE-3 BOND COUNTS ONLY WITH ITS PRESIG, census_confirmations DEEP (kanban #1053): an output of node 2 with none yet, then with one
  const late = postOne(2, {}, { presig: false });
  rt.mine(3);
  const censusAtNow = () => { const h = rt.height(); return censusOfView(rt.blocksFrom(0, h), decodeRoundContract(encodeRoundContract({ ...base, censusHeight: h, committeeTimeMs: 1n, startTimeMs: 2n, entryCloseMs: 2n })), { network: 'regtest', standingKeys: [{ epoch: 0, publicKey: key0, height: 0 }] }); };
  const before = censusAtNow(), lateHex = toHex(fromHex(late.txid).reverse());
  const out = before.excluded.find((x) => toHex(x.txid) === lateHex);
  ask('a template-3 bond with no presig is not counted, and is named', !!out && out.step === 'presig' && !before.entries.some((x) => toHex(x.txid) === lateHex), out ? out.why : 'not named');
  rt.include([rt.postBondPresig(ids[2].secret, late).hex]);
  rt.mine(1);
  ask('with its presig on chain it counts, by one signature check', censusAtNow().entries.some((x) => toHex(x.txid) === lateHex));
  rt.mine(26);
  const H = rt.height();
  const anchorHeaders = []; for (let h = 0; h <= H; h++) anchorHeaders.push(cli('getblockheader', cli('getblockhash', String(h)), 'false'));
  writeFileSync(join(dir, 'attach', 'headers.bin'), Buffer.from(anchorHeaders.join(''), 'hex'));

  const now0 = BigInt(Date.now());
  base.censusHeight = H;
  const shaped = decodeRoundContract(encodeRoundContract({ ...base, committeeTimeMs: now0, startTimeMs: now0 + 200000n, entryCloseMs: now0 + 200000n }));
  const census = censusOfView(rt.blocksFrom(0, H), shaped, { network: 'regtest', standingKeys: [{ epoch: 0, publicKey: key0, height: 0 }] });
  if (!census.ok) throw new Error(`no census at ${H}: ${census.why}`);
  base.censusRoot = census.root;
  const started = census.entries.filter((e) => e.advert.bondScriptTemplateVersion === BOND_TEMPLATE_V3);
  ask('the census at the round holds every bond, the template-3 ones counted', census.entries.length === NODES + 2 && started.length === NODES / 2 + 2, `${census.entries.length} outputs of ${NODES} nodes, ${started.length} on template 3`);

  // a block every 2 s from here on: a round's beacon is the first block whose median time past is after its committee time
  mining = true;
  (async () => { while (mining) { try { rt.mine(1); } catch { /* bitcoind busy */ } await wait(2000); } })();
  startSeat(4);
  await up(4);
  const committeeTimeMs = BigInt(Date.now()) + 20000n, startTimeMs = committeeTimeMs + 320000n;
  const c = decodeRoundContract(encodeRoundContract({ ...base, committeeTimeMs, startTimeMs, entryCloseMs: startTimeMs }));
  const rid = roundId(c), ridHex = toHex(rid), body = encodeRoundContract(c);
  const post = (i) => fetch(`${url(i)}/round`, { method: 'POST', body, signal: AbortSignal.timeout(30000) }).then(async (r) => `${r.status} ${r.ok ? '' : (await r.text()).slice(0, 160)}`, (e) => `error ${e.message}`);
  const first = await post(4);
  ask('a seat takes the round', first.startsWith('2'), first);
  if (!first.startsWith('2')) throw new Error('no round');

  // ONLY THE DRAWN RUN: 24 real seats are not needed for what is measured, and the census needs only their bonds
  let drawn = null;
  for (let t = 0; t < 160 && !drawn; t++) {
    const r = await fetch(`${url(4)}/rounds?next=64`, { signal: AbortSignal.timeout(20000) }).then((x) => (x.ok ? x.json() : null), () => null);
    const row = r && (r.rounds || []).find((x) => x.id === ridHex);
    if (row && row.committee && row.committee.drawn) drawn = row.committee.drawn;
    if (!drawn) await wait(1000);
  }
  if (!drawn) throw new Error('no seat drew the round');
  const seatsDrawn = [...new Set([...drawn.game, ...drawn.settlement])].map((k) => keyHex.indexOf(k));
  ask('the draw reaches at most 18 nodes of 24, so there are nodes left for panels', seatsDrawn.length < NODES - 5, `${seatsDrawn.length} drawn over both roles, ${NODES - seatsDrawn.length} left`);
  for (const i of seatsDrawn) startSeat(i);
  for (const i of seatsDrawn) await up(i);
  const said2 = await Promise.all(seatsDrawn.filter((i) => i !== 4).map(post));
  ask('every drawn seat takes the round', said2.every((s) => s.startsWith('2')), said2.filter((s) => !s.startsWith('2')).slice(0, 2).join(' / '));
  const close = Number(seatingCloseMs(c));
  await wait(Math.max(0, close - Date.now()));
  console.log(`#972 seating closed, ${seatsDrawn.length} seats up`);

  const certOf = async (i, role) => { const r = await fetch(`${url(i)}/seating?round=${ridHex}&role=${role}`, { signal: AbortSignal.timeout(8000) }).catch(() => null); return r && r.ok ? fromHex((await r.json()).cert) : null; };
  const live = [...seatsDrawn];
  const certs = {};
  for (const role of ['settlement', 'game']) {
    for (let t = 0; t < 90 && !certs[role]; t++) { for (const i of live) { const b = await certOf(i, role); if (b) { certs[role] = b; break; } } if (!certs[role]) await wait(1000); }
  }
  ask('both roles certified', !!certs.settlement && !!certs.game);
  const dec = decodeSeatingCertificate(certs.settlement);
  const wants = dec.seated.flatMap((k) => census.entries.filter((e) => toHex(e.pubkey) === toHex(k) && e.advert.bondScriptTemplateVersion === BOND_TEMPLATE_V3));
  ask('the certificate carries one presig per template-3 bond it seats, none for the others', (dec.presigs || []).length === wants.length && wants.length > 0, `${dec.seated.length} seated, ${wants.length} template-3 outputs, ${dec.presigs.length} presigs, ${certs.settlement.length} bytes`);
  const size = encodeSeatingCertificate({ ...dec, presigs: null }).length;
  console.log(`#972 the presigs add ${certs.settlement.length - size} bytes to the certificate of ${size}`);
  const held = await Promise.all(live.map(async (i) => { const b = await certOf(i, 'settlement'); return b && toHex(b) === toHex(certs.settlement); }));
  ask('every drawn seat holds that one certificate', held.every(Boolean), `${held.filter(Boolean).length} of ${held.length}`);

  // A SEAT REFUSES A SEATING WHOSE MEMBER'S PRESIG IS MISSING OR DOES NOT VERIFY
  const cut = encodeSeatingCertificate({ ...dec, presigs: dec.presigs.slice(1) });
  const refused = await fetch(`${url(live[0])}/seating`, { method: 'POST', body: cut, signal: AbortSignal.timeout(8000) });
  const why1 = await refused.text();
  ask('a certificate with a presig cut out is refused', refused.status === 409 && /no slash_presig/.test(why1), why1.slice(0, 90));
  const bent = { ...dec, presigs: dec.presigs.map((p, i) => (i ? p : { ...p, signature: Uint8Array.from(p.signature, (b, j) => (j === 3 ? b ^ 1 : b)) })) };
  const refused2 = await fetch(`${url(live[0])}/seating`, { method: 'POST', body: encodeSeatingCertificate(bent), signal: AbortSignal.timeout(8000) });
  const why2 = await refused2.text();
  ask('a certificate with a presig bent is refused', refused2.status === 409 && /does not verify/.test(why2), why2.slice(0, 90));

  // THE DOOR, and Bitcoin as the judge
  const e = wants[0], node = keyHex.indexOf(toHex(e.pubkey));
  const door = await (await fetch(`${url(live[0])}/slash-presig?round=${ridHex}&txid=${toHex(e.txid)}&vout=${e.vout}`, { signal: AbortSignal.timeout(8000) })).json();
  ask('any seat serves a seated node\'s presig, with the panels its hold names', door.node === keyHex[node] && !!door.panels, door.panels ? `n ${door.panels.n}, t ${door.panels.t}` : 'no panels');
  const onPanels = new Set([...door.panels.a, ...door.panels.b]);
  ask('the panels leave out every drawn node', ![...drawn.game, ...drawn.settlement].some((k) => onPanels.has(k)), `${onPanels.size} on the panels`);
  ask('the panels are full for what is left', door.panels.n >= 3 && door.panels.a.length === door.panels.n && door.panels.b.length === door.panels.n);
  const clocks = holdClocksOf(NETWORK_ID_REGTEST), value = BigInt(e.bondSats);
  const hold = holdOutputKey({ nodeKey: e.pubkey, censusKey: key0, panelA: door.panels.a.map(fromHex), panelB: door.panels.b.map(fromHex), bondMaturity: e.advert.bondMaturityHeight, ...clocks }, { tweakPoint });
  const presig = fromHex(door.signature);
  ask('the door\'s presig verifies over the hold those panels rebuild', slashPresigVerifies(presig, slashPresigDigest({ bond: { txid: e.txid, vout: e.vout, value, script: e.script }, nodeKey: e.pubkey, censusKey: key0, holdScript: hold.script }), e.pubkey, verify));

  const leafScript = slashStartLeaf(e.pubkey, key0), leafHash = tapLeafHash(leafScript);
  const payer = schnorr.utils.randomSecretKey(), feeLeaf = Uint8Array.from([0x20, ...schnorr.getPublicKey(payer), 0xac]);
  const q = tweakPoint(HOLD_INTERNAL_KEY, tapTweak(HOLD_INTERNAL_KEY, tapLeafHash(feeLeaf)));
  const feeScript = fromHex(`5120${toHex(q.outputKey)}`), fee = rt.fund(feeScript, '0.001');
  mining = false; await wait(2500);
  rt.mine(1);
  const bondIn = { txid: e.txid, vout: e.vout, sequence: SLASH_START_SEQUENCE }, feeIn = { txid: fromHex(fee.txid).reverse(), vout: fee.vout, sequence: SLASH_START_SEQUENCE };
  const tx = { version: 2, locktime: 0, inputs: [bondIn, feeIn], outputs: [{ value, script: hold.script }, arbitrationCommitment(taggedHash('ARENA/v1/SlashProof', new Uint8Array(32).fill(7)), rt.height(), new Uint8Array(0)), { value: fee.value - 5000n, script: rt.payTo() }] };
  const prevouts = [{ value, script: e.script }, { value: fee.value, script: feeScript }];
  const built = bonds.get(node).find((p) => toHex(fromHex(p.txid).reverse()) === toHex(e.txid)).built;
  const signStart = (nodeSig) => toHex(serializeSpend({ ...tx, witnesses: [
    scriptPathWitness({ stack: [schnorr.sign(tapSighash({ ...tx, prevouts, inputIndex: 0, leafHash }), censusSecret), nodeSig], script: leafScript, controlBlock: controlBlockFor('slash', built).controlBlock }),
    scriptPathWitness({ stack: [schnorr.sign(tapSighash({ ...tx, prevouts, inputIndex: 1, leafHash: tapLeafHash(feeLeaf) }), payer)], script: feeLeaf, controlBlock: Uint8Array.from([TAPLEAF_VERSION | q.parity, ...HOLD_INTERNAL_KEY]) }),
  ] }));
  const bad = presig.slice(); bad[5] ^= 1;
  let tookBad = true; try { cli('testmempoolaccept', JSON.stringify([signStart(bad)])); tookBad = JSON.parse(cli('testmempoolaccept', JSON.stringify([signStart(bad)])))[0].allowed; } catch { tookBad = false; }
  ask('Bitcoin refuses a bent presig', tookBad === false);
  const startTxid = cli('sendrawtransaction', signStart(presig));
  rt.mine(1);
  ask('a seat\'s presig, the census key and the proof\'s OP_RETURN start a real slash, into that hold', JSON.parse(cli('getrawtransaction', startTxid, '1')).confirmations === 1, `${JSON.parse(cli('getrawtransaction', startTxid, '1')).vsize} vB`);

  // THOSE PANELS RELEASE IT: t of n of each, at the hold clock
  const secretOf = (k) => ids[keyHex.indexOf(k)].secret;
  const rel = { version: 2, locktime: 0, inputs: [{ txid: fromHex(startTxid).reverse(), vout: 0, sequence: clocks.holdBlocks }], outputs: [arbitrationCommitment(taggedHash('ARENA/v1/SlashProof', new Uint8Array(32).fill(7)), rt.height(), new Uint8Array(32).fill(9)), { value: value - 3000n, script: rt.payTo() }] };
  const relDigest = tapSighash({ ...rel, prevouts: [{ value, script: hold.script }], inputIndex: 0, leafHash: hold.leaves.release });
  const sorted = (list) => [...list].sort();
  const line = (list) => sorted(list).map((k, i) => (i < door.panels.t ? schnorr.sign(relDigest, secretOf(k)) : new Uint8Array(0)));
  const stack = [...line(door.panels.a), ...line(door.panels.b)].reverse();
  const relTxid = cli('sendrawtransaction', toHex(serializeSpend({ ...rel, witnesses: [scriptPathWitness({ stack, script: hold.scripts.release, controlBlock: holdControlBlock('release', hold).controlBlock })] })));
  rt.mine(1);
  ask('the door\'s panels release that hold, t of n of each', JSON.parse(cli('getrawtransaction', relTxid, '1')).confirmations === 1, `${JSON.parse(cli('getrawtransaction', relTxid, '1')).vsize} vB`);

  // A BOND'S OWN PRESIG, FOR A NODE THAT WAS NEVER SEATED (RULED 2026-11-02, kanban #1053): no panels, a hold with no release leaf, the census key at the fallback
  const never = census.entries.find((x) => x.advert.bondScriptTemplateVersion === BOND_TEMPLATE_V3 && !seatsDrawn.includes(keyHex.indexOf(toHex(x.pubkey))));
  ask('a template-3 node no round drew exists', !!never);
  const posted2 = bonds.get(keyHex.indexOf(toHex(never.pubkey))).find((p) => toHex(fromHex(p.txid).reverse()) === toHex(never.txid));
  const own = bondPresigDigest({ bond: { txid: never.txid, vout: never.vout, value: BigInt(never.bondSats), script: never.script }, advert: { ...never.advert, nodePubkey: never.pubkey, censusKey: key0 }, networkId: NETWORK_ID_REGTEST, tweakPoint });
  const updateRaw = rt.blocksFrom(never.presigBy.height, never.presigBy.height).blocks[0].transactions.find((t) => toHex(parseTransaction(t).txid) === toHex(never.presigBy.txid));
  const ownPresig = readAdvertUpdate(updateRaw, { network: 'regtest' }).advert.slashPresig;
  ask('the bond\'s presig is read off its update and verifies over its own hold, no panels', own.ok && slashPresigVerifies(ownPresig, own.digest, never.pubkey, verify) && !own.hold.leaves.release);
  const fee2 = rt.fund(feeScript, '0.001');
  rt.mine(1);
  const tx2 = { version: 2, locktime: 0, inputs: [{ txid: never.txid, vout: never.vout, sequence: SLASH_START_SEQUENCE }, { txid: fromHex(fee2.txid).reverse(), vout: fee2.vout, sequence: SLASH_START_SEQUENCE }],
    outputs: [{ value: BigInt(never.bondSats), script: own.hold.script }, arbitrationCommitment(taggedHash('ARENA/v1/SlashProof', new Uint8Array(32).fill(8)), rt.height(), new Uint8Array(0)), { value: fee2.value - 5000n, script: rt.payTo() }] };
  const prev2 = [{ value: BigInt(never.bondSats), script: never.script }, { value: fee2.value, script: feeScript }];
  const leaf2 = slashStartLeaf(never.pubkey, key0), leaf2Hash = tapLeafHash(leaf2);
  const start2 = cli('sendrawtransaction', toHex(serializeSpend({ ...tx2, witnesses: [
    scriptPathWitness({ stack: [schnorr.sign(tapSighash({ ...tx2, prevouts: prev2, inputIndex: 0, leafHash: leaf2Hash }), censusSecret), ownPresig], script: leaf2, controlBlock: controlBlockFor('slash', posted2.built).controlBlock }),
    scriptPathWitness({ stack: [schnorr.sign(tapSighash({ ...tx2, prevouts: prev2, inputIndex: 1, leafHash: tapLeafHash(feeLeaf) }), payer)], script: feeLeaf, controlBlock: Uint8Array.from([TAPLEAF_VERSION | q.parity, ...HOLD_INTERNAL_KEY]) }),
  ] })));
  rt.mine(1);
  ask('that presig, the census key and a proof\'s OP_RETURN start a real slash', JSON.parse(cli('getrawtransaction', start2, '1')).confirmations === 1, `${JSON.parse(cli('getrawtransaction', start2, '1')).vsize} vB`);
  ask('its hold output stays the bond in the census', censusAtNow().entries.some((x) => toHex(x.txid) === toHex(never.txid) && x.hold));
  const fb = { version: 2, locktime: 0, inputs: [{ txid: fromHex(start2).reverse(), vout: 0, sequence: clocks.fallbackBlocks }], outputs: [{ value: BigInt(never.bondSats) - 5000n, script: rt.payTo() }] };
  const fbSpend = () => toHex(serializeSpend({ ...fb, witnesses: [scriptPathWitness({ stack: [schnorr.sign(tapSighash({ ...fb, prevouts: [{ value: BigInt(never.bondSats), script: own.hold.script }], inputIndex: 0, leafHash: own.hold.leaves.fallback }), censusSecret)], script: own.hold.scripts.fallback, controlBlock: holdControlBlock('fallback', own.hold).controlBlock })] }));
  rt.mine(clocks.fallbackBlocks - 2);
  ask('the fallback is not open a block early', JSON.parse(cli('testmempoolaccept', JSON.stringify([fbSpend()])))[0].allowed === false);
  rt.mine(1);
  const fbTxid = cli('sendrawtransaction', fbSpend());
  rt.mine(1);
  ask('the census key pays it at slash_fallback_blocks', JSON.parse(cli('getrawtransaction', fbTxid, '1')).confirmations === 1, `${clocks.fallbackBlocks} blocks after the start`);
} catch (e) { wrong += 1; console.error(`#972 stopped: ${e.stack}`); console.error(`#972 logs in ${dir}`); env.SP_KEEP = '1'; }
await stopAll();
console.log(wrong ? `#972 ${wrong} wrong` : '#972 all as expected');
process.exit(wrong ? 1 : 0);
