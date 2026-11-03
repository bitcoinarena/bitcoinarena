#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GUARDIAN TAKES HIS MATURE BOND BY PATH A WHILE SEATED (spec 23A.5, kanban #1054). A private regtest, never testnet4, never a live seat. Four bonded guardians, each with the record code a seat
// runs (federation-records.js) over the census of the real chain, signatures asked of one another in process. A real recovery spend is mined, and the record every seat signs has him ABANDONED
// from that block, under that txid. The same seats reading no spend are run beside it: that is the record as it was before. One line per question; exits 1 if any differs.
//
// AND WHAT THE ROW LEFT (spec 23A.5, ruled on kanban #1058, built on #1059). A second federation on the same chain: its guardian b3 holds two outputs and spends the large one, so he falls under the
// floor with 20,000 sat unspent; b2 spends one of two and stays above it. Two seats' doors, GET /slashes and GET /federation-records-at as server.js serves them, in front of the service itself
// (tools/arbiter.mjs --once, a process of its own, on this chain). Two of the doors lie: one hands the true row's record cut under its threshold, one lists a row for a guardian nobody filed.
//
// AND THE PROOF A SLASH COMMITS TO (spec 23A.5, ruled on kanban #1062). The slash's OP_RETURN is the hash of an AbandonedProof. It is fetched by that hash over HTTP as anyone would, re-checked with
// nothing from the service, also after the output is gone, and decideReturn, the reference node's own reading, keeps the slash on it. A row from before the network's point moves no money.
//
// AND THE HASH COVERS THE RECORD (kanban #1065, reversing #1064): two seats holding one record under different signatures hold two valid proofs of one offence, each under its own hash, and a record
// proof; a seat that held nothing serves both once it is handed them. And CHAIN_CENSUS_SUM_HEIGHT: the height read decides, either side of a point, and seats with the point above the height sign
// the bytes of the old read.
//
// AND THE CHAIN'S CENSUS OF A NODE WITH SEVERAL OUTPUTS (kanban #1063). A third federation: c3 holds 40,000 sat three times, seated by a census at protocol 19. He spends one and still holds 80,000:
// seats reading the chain at protocol 1 apply the floor to each output, so they write him ABANDONED; the read a seat makes keeps him. He spends a second, is under the floor by the sum, and what he
// left goes the whole way to a slash.
//
//   node tools/guardian-bond-spent-regtest.mjs            (from packages/arena-node; GS_DIR, GS_BASE_PORT, BITCOIN_BIN)
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1.js';
import { regtest } from './regtest-bond.mjs';
import { censusOfView } from '../src/roster.js';
import { federationRecords } from '../src/federation-records.js';
import { withdrawSpend } from '../src/bond-withdraw.js';
import { inviteForGuardians, readInvite } from '../src/invite.js';
import { arbitrationMembers } from '../src/arbiter.js';
import { tweakPoint, combine } from '../src/curve.js';
import { joinSignedRecord, splitSignedRecord, federationRecordId } from '../../arena-protocol/src/federation-record.js';
import { bondsOf, encodeAbandonedProof, decodeAbandonedProof, abandonedProofId } from '../../arena-protocol/src/abandoned-slash.js';
import { chainCensusContract, nodeBondOf } from '../../arena-protocol/src/census.js';
import { arbitrationCommitmentIn } from '../../arena-protocol/src/arbitration-tx.js';
import { decideReturn, abandonedProofChecks, proofChecksOf } from '../src/hold-return.js';
import { escrowOutput } from '../../arena-protocol/src/arbitration-tx.js';
import { PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '../../arena-protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';

const env = process.env;
const BIN = env.BITCOIN_BIN || '/mnt/bitcoin/bitcoin-31.1/bin';
const BASE = Number(env.GS_BASE_PORT || 28740), RPC = BASE, P2P = BASE + 1;
const dir = mkdtempSync(join(env.GS_DIR || '/mnt/bitcoin/relocated/claude-tmp/claude-1000', 'guardian-bond-spent-'));
const RT = join(dir, 'chain');
mkdirSync(RT);
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const cli = (...a) => execFileSync(join(BIN, 'bitcoin-cli'), ['-regtest', `-datadir=${RT}`, `-rpcport=${RPC}`, ...(['listwallets', 'loadwallet', 'createwallet', 'stop'].includes(a[0]) ? [] : ['-rpcwallet=arena']), ...a], { encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
let wrong = 0, ticket = '#1054';
const ask = (label, ok, said = '') => { if (!ok) wrong += 1; console.log(`${ticket} ${ok ? 'as expected' : 'WRONG      '} | ${label}${said === '' ? '' : ` | ${said}`}`); };

const FED = new Uint8Array(32).fill(0x37), FED2 = new Uint8Array(32).fill(0x38), FED3 = new Uint8Array(32).fill(0x39);
const inviteOf = (id, at) => inviteForGuardians(id, [{ url: `ws://${at}.invalid`, peer: 0 }]);
const INVITES = new Map([[toHex(FED), inviteOf(FED, 'guardian-a')], [toHex(FED2), inviteOf(FED2, 'guardian-b')], [toHex(FED3), inviteOf(FED3, 'guardian-c')]]);
const inviteFederationId = (inv) => fromHex(readInvite(inv).federationId);
const fourOf = (fed, secretByte, keyByte, name) => Array.from({ length: 4 }, (_, i) => { const secret = new Uint8Array(32).fill(secretByte + i); return { fed, secret, pubkey: schnorr.getPublicKey(secret), guardianKey: Uint8Array.from([2, ...new Uint8Array(32).fill(keyByte + i)]), endpoint: `http://seat-${name}${i}.invalid` }; });
const nodes = fourOf(FED, 0x20, 0x60, 'a'), others = fourOf(FED2, 0x30, 0x70, 'b'), thirds = fourOf(FED3, 0x40, 0x80, 'c'), everyone = [...nodes, ...others, ...thirds];
let tip = 0, rt = null;
const SLACK = 60;   // each funding mines blocks, so a bond posted first must still count as confirmed in time with eleven more behind it
// one read per height and contract: twelve seats ask the same census, and blocks at or below a height do not change here
const censusBy = (contractAt) => { const read = new Map(); return (h) => { if (read.has(h)) return read.get(h); const c = censusOfView(rt.blocksFrom(0, h), contractAt(h), { network: 'regtest' }); if (!c.ok) throw new Error(c.why); read.set(h, c); return c; }; };
const roundAt = (protocolVersion) => (h) => ({ networkId: NETWORK_ID_REGTEST, censusHeight: h, censusConfirmations: 1, bondMinSats: 50000n, protocolVersion });
const censusAt = censusBy((h) => chainCensusContract({ networkId: NETWORK_ID_REGTEST, height: h, bondMinSats: 50000n }));   // the read main.js makes
const censusV1 = censusBy(roundAt(1)), censusV19 = censusBy(roundAt(19));

/** Seats, as server.js wires them: `reading` false leaves spendsAt out, which is what a seat did before. `read` is their chain census, `held` the signed records they start with. */
function seats(reading, read = censusAt, held = [], over = {}) {
  const list = everyone.map((n) => federationRecords({ round: { pubkey: n.pubkey, identity: { secret: n.secret } }, newest: () => null, roster: { censusFor: () => ({ ok: false, why: 'none' }) }, inviteFor: (fid) => INVITES.get(fid) || null, networkId: NETWORK_ID_REGTEST,
    censusAt: async (h) => read(h).entries, chainTip: async () => tip, ...(reading ? { spendsAt: async (h) => read(h).excluded.filter((x) => x.spentBy), bondsAt: async (h) => bondsOf(read(h)) } : {}),
    ...(held.length ? { store: { load: () => held, save: () => {} } } : {}), ...over,
    fetcher: async (u) => {
      const j = list[everyone.findIndex((m) => u.startsWith(m.endpoint))], q = new URL(u);
      const body = await j.mySignature(q.searchParams.get('federation'), Number(q.searchParams.get('height')), q.searchParams.get('reserve'));
      return new Response(JSON.stringify(body), { status: body.ok ? 200 : 404 });
    } }));
  return list;
}
const of = (fed, rows) => rows.find((x) => x.federation === toHex(fed));
const gatherAll = async (list, fed = FED) => { const out = []; for (const [i, s] of list.entries()) if (i !== 3 && i !== 7 && i !== 11) out.push(of(fed, await s.gatherAll(inviteFederationId))); return out; };
const heldBy = (s, fed = FED) => splitSignedRecord(fromHex(of(fed, s.list()).record)).record;
const outpoint = (posted) => toHex(fromHex(posted.txid).reverse());

// GET /slashes, GET /slashes?proof= and PUT /slash/<id> as server.js answers them, and the event door; `extra` adds rows of the door's own, `cut` lists each proof with its record one signature
// short, under the hash those bytes have: a true row and a true hash, and only the threshold can catch it. `swap` hands the bytes of `cut`'s proof under the true hash: those are a copy of nothing
const events = [];
const cutRecord = (bytes) => { const s = splitSignedRecord(bytes); return joinSignedRecord(s.body, s.signatures.slice(0, s.record.threshold - 1)); };
function door(seat, port, { extra = null, cut = false, swap = false } = {}) {
  const forged = new Map();
  const listed = async () => {
    const rows = await seat.abandonedSlashes();
    for (const x of (extra ? extra() : [])) { forged.set(x.proof, x); rows.push(x); }
    if (!cut && !swap) return rows;
    return rows.map((r) => {
      const p = decodeAbandonedProof(seat.abandonedProof(r.proof)), bytes = encodeAbandonedProof({ ...p, record: cutRecord(p.record) });
      if (swap) { forged.set(r.proof, { bytes }); return r; }
      const id = toHex(abandonedProofId(bytes));
      forged.set(id, { bytes });
      return { ...r, proof: id };
    });
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'), json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url.pathname === '/slashes' && url.searchParams.has('proof')) {
      const id = url.searchParams.get('proof'), lie = forged.get(id), bytes = lie ? lie.bytes : seat.abandonedProof(id);
      res.writeHead(bytes ? 200 : 404, { 'content-type': 'application/octet-stream' });
      return res.end(bytes ? Buffer.from(bytes) : undefined);
    }
    if (url.pathname === '/slashes') return json({ slashes: [], auditSlashes: [], doubleSlashes: [], tableSlashes: [], abandonedSlashes: await listed() });
    if (req.method === 'PUT' && url.pathname.startsWith('/slash/')) { const c = []; for await (const d of req) c.push(d); const r = await seat.takeAbandonedProof(url.pathname.slice(7), new Uint8Array(Buffer.concat(c)), inviteFederationId); res.writeHead(r.status); return res.end(r.why || 'kept'); }
    if (url.pathname === '/liquidations/events') { let b = ''; for await (const c of req) b += c; events.push(JSON.parse(b)); return json({ ok: true }); }
    res.writeHead(404); return res.end();
  });
  return new Promise((r) => { server.listen(port, '127.0.0.1', () => r(server)); });
}
const fetched = async (port, id) => { const r = await fetch(`http://127.0.0.1:${port}/slashes?proof=${id}`); return r.ok ? new Uint8Array(await r.arrayBuffer()) : null; };
/** One pass of the service itself, a process of its own, on this chain and these doors. */
const arbiterPass = (ports, over = {}) => new Promise((done) => {
  const c = spawn(process.execPath, ['tools/arbiter.mjs', '--once'], { cwd: join(dirname(fileURLToPath(import.meta.url)), '..'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, ARENA_ARBITER_NETWORK: 'regtest', ARENA_ARBITER_SEATS: ports.map((p) => `http://127.0.0.1:${p}`).join(','), ARENA_BITCOIND_URL: `http://127.0.0.1:${RPC}`, ARENA_BITCOIND_COOKIE: join(RT, 'regtest', '.cookie'),
      ARENA_ARBITER_PORT: String(BASE + 2), ARENA_ARBITER_STATE: join(dir, 'arbiter.json'), ...over } });
  let log = '';
  c.stdout.on('data', (d) => { log += d; }); c.stderr.on('data', (d) => { log += d; });
  c.on('exit', (code) => done({ code, log }));
});

let bitcoind = null;
try {
  bitcoind = spawn(join(BIN, 'bitcoind'), ['-regtest', `-datadir=${RT}`, `-rpcport=${RPC}`, `-port=${P2P}`, '-listen=0', '-listenonion=0', '-txindex=1', '-fallbackfee=0.0001', '-server=1'], { stdio: 'ignore' });
  for (let t = 0; t < 60; t++) { try { cli('listwallets'); break; } catch { await wait(500); } }
  try { cli('createwallet', 'arena'); } catch { /* there */ }
  rt = regtest(cli);
  rt.mine(110);
  const posted = nodes.map((n, i) => rt.postBond(n.secret, { endpoint: n.endpoint.replace('http', 'ws'), bondSats: 100000n, fundBtc: '0.02', slackBlocks: SLACK, protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS], operatorId: `op${i}`, guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] }));
  const postedB = others.map((n, i) => rt.postBond(n.secret, { endpoint: n.endpoint.replace('http', 'ws'), bondSats: 100000n, fundBtc: '0.02', slackBlocks: SLACK, protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS], operatorId: `opb${i}`, guardianOf: [{ federationId: FED2, guardianKey: n.guardianKey }] }));
  const postedC = thirds.map((n, i) => rt.postBond(n.secret, { endpoint: n.endpoint.replace('http', 'ws'), bondSats: i === 3 ? 40000n : 100000n, fundBtc: '0.02', slackBlocks: SLACK, protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS], operatorId: `opc${i}`, guardianOf: [{ federationId: FED3, guardianKey: n.guardianKey }] }));
  rt.include([...posted, ...postedB, ...postedC].map((p) => p.hex));
  rt.mine(1);
  // b2's second output, 60,000 sat, and b3's: he will spend his 100,000 and be left with 20,000, under the floor of 50,000
  const secondOf = (i, sats) => rt.postBond(others[i].secret, { endpoint: others[i].endpoint.replace('http', 'ws'), bondSats: sats, fundBtc: '0.02', slackBlocks: SLACK, advert: postedB[i].advert });
  const extraB2 = secondOf(2, 60000n), leftB3 = secondOf(3, 20000n);
  // c3's other two outputs: 40,000 sat three times, each under the floor of 50,000 and together well above it
  const fortyOf = () => rt.postBond(thirds[3].secret, { endpoint: thirds[3].endpoint.replace('http', 'ws'), bondSats: 40000n, fundBtc: '0.02', slackBlocks: SLACK, advert: postedC[3].advert });
  const forty2 = fortyOf(), forty3 = fortyOf();
  rt.include([extraB2.hex, leftB3.hex, forty2.hex, forty3.hex]);
  rt.mine(12);
  const a = seats(true), old = seats(false);
  const basisTip = () => { tip = rt.height() + 6; };   // a record's census height is six below the tip, on a multiple of six
  basisTip();
  for (const s of [...a, ...old]) for (const got of await s.gatherAll(inviteFederationId)) if (!got.ok) throw new Error(got.why);
  const before = heldBy(a[0]);
  // A SEAT OF A SERIES AT PROTOCOL 19 SEATS c3 ON HIS SUM: the record both sets of seats below start from
  const nineteen = seats(true, censusV19);
  const seated3 = await gatherAll(nineteen, FED3);
  const rc = heldBy(nineteen[8], FED3), heldC = [{ federation: toHex(FED3), record: of(FED3, nineteen[8].list()).record }];
  ticket = '#1063';
  ask('a census at protocol 19 seats 40,000 sat three times as one guardian of 120,000', seated3.every((x) => x.ok) && rc.nominal === 4 && rc.guardians.some((x) => toHex(x.nodePubkey) === toHex(thirds[3].pubkey)) && nodeBondOf(censusV19(rc.height).entries, thirds[3].pubkey).bondSats === 120000n, `nominal ${rc.nominal}, his bond ${nodeBondOf(censusV19(rc.height).entries, thirds[3].pubkey).bondSats} sat`);
  ticket = '#1054';
  ask('four bonded guardians sign one record, all seated', before.nominal === 4 && before.gone.length === 0, `nominal ${before.nominal}, threshold ${before.threshold}, cap ${before.exposureCapSats} sat, height ${before.height}`);

  const p = posted[3];
  rt.mine(Math.max(0, Math.max(p.maturity, postedB[3].maturity, extraB2.maturity, forty2.maturity, forty3.maturity) + 1 - rt.height()));
  const spend = withdrawSpend({ bond: { txid: p.txid, vout: 0, sats: String(p.bondSats), maturity: p.maturity, template: 2 }, nodeSecret: nodes[3].secret, network: 'regtest', script: rt.payTo() });
  const txid = cli('sendrawtransaction', spend.hex);
  const pathA = (i, bond) => cli('sendrawtransaction', withdrawSpend({ bond: { txid: bond.txid, vout: 0, sats: String(bond.bondSats), maturity: bond.maturity, template: 2 }, nodeSecret: others[i].secret, network: 'regtest', script: rt.payTo() }).hex);
  const spendB3 = pathA(3, postedB[3]), spendB2 = pathA(2, extraB2);
  const pathC = (bond) => cli('sendrawtransaction', withdrawSpend({ bond: { txid: bond.txid, vout: 0, sats: String(bond.bondSats), maturity: bond.maturity, template: 2 }, nodeSecret: thirds[3].secret, network: 'regtest', script: rt.payTo() }).hex);
  pathC(postedC[3]);
  rt.mine(1);
  const spentAt = rt.height();
  ask('a real path A spend of his mature bond is mined', JSON.parse(cli('getrawtransaction', txid, '1')).confirmations === 1, `${txid.slice(0, 16)} at ${spentAt}`);
  // money bonded after the offence, still under the floor: it stood for nothing at the time
  const lateB3 = secondOf(3, 10000n);
  rt.include([lateB3.hex]);
  rt.mine(12);
  basisTip();

  const said = await gatherAll(a);
  ask('every seat gathers it: three signers of a nominal four', said.every((x) => x.ok && x.signers === 3), said.map((x) => `${x.status}, ${x.signers} signers`).join(' / '));
  const r = heldBy(a[0]);
  ask('the census dropped him, and the record keeps him listed', r.nominal === 4 && r.threshold === 3 && r.guardians.length === 4, `nominal ${r.nominal}, threshold ${r.threshold}, ${r.guardians.length} listed`);
  const g = r.gone[0];
  ask('ABANDONED from the spend\'s block', r.gone.length === 1 && toHex(g.peerKey) === toHex(nodes[3].guardianKey) && g.kind === 2 && g.sinceHeight === spentAt, `since ${g && g.sinceHeight}, kind ${g && g.kind}`);
  ask('proof_ref is that spend\'s txid', !!g && toHex(g.proofRef) === toHex(Uint8Array.from(fromHex(txid)).reverse()), g ? toHex(g.proofRef).slice(0, 16) : '');
  ask('the federation counts him gone at once', of(FED, a[0].list()).status === 'CRITICAL', of(FED, a[0].list()).status);

  const was = await gatherAll(old);
  const o = heldBy(old[0]);
  ask('seats that read no spend: the record as it was, a shrunk nominal and nobody gone', was.every((x) => x.ok) && o.nominal === 3 && o.gone.length === 0, `${of(FED, old[0].list()).status}, nominal ${o.nominal}, threshold ${o.threshold}, gone ${o.gone.length}`);

  ticket = '#1059';
  const rowsA = (await a[0].abandonedSlashes()).filter((x) => x.federation === toHex(FED));
  ask('a guardian who spent all he had: the record is what stands, and no seat lists a slash', rowsA.length === 0, `${rowsA.length} rows`);
  const gatheredB = await gatherAll(a, FED2);
  const rb = heldBy(a[4], FED2), gb = rb.gone[0];
  ask('b3 under the floor with an output left is ABANDONED, b2 above it stays seated', gatheredB.every((x) => x.ok) && rb.gone.length === 1 && toHex(gb.peerKey) === toHex(others[3].guardianKey) && gb.sinceHeight === spentAt && toHex(gb.proofRef) === outpoint({ txid: spendB3 }),
    `${of(FED2, a[4].list()).status}, ${rb.gone.length} gone, since ${gb && gb.sinceHeight}, proof_ref ${gb ? toHex(gb.proofRef).slice(0, 16) : ''}, b2's spend ${spendB2.slice(0, 16)} files nothing`);
  const listed = (await a[4].abandonedSlashes()).filter((x) => x.federation === toHex(FED2));
  ask('the seat lists the output he left, and not the one bonded after the spend', listed.length === 1 && listed[0].txid === outpoint(leftB3) && listed[0].sats === '20000' && listed[0].proofRef === toHex(gb.proofRef), listed.map((x) => `${x.txid.slice(0, 16)}:${x.vout} ${x.sats} sat`).join(', '));

  const honest = await door(a[4], BASE + 3);
  const cutter = await door(a[5], BASE + 4, { cut: true });
  // a true record and a row nobody filed: the liar's proof names b0 and his bond under the true proof_ref
  const falseProof = encodeAbandonedProof({ federationId: FED2, nodePubkey: others[0].pubkey, proofRef: gb.proofRef, txid: fromHex(outpoint(postedB[0])), vout: 0, record: a[6].recordOf(toHex(FED2)).bytes }), falseId = toHex(abandonedProofId(falseProof));
  const liar = await door(a[6], BASE + 5, { extra: () => [{ ...listed[0], proof: falseId, bytes: falseProof, peer: toHex(others[0].guardianKey), node: toHex(others[0].pubkey), txid: outpoint(postedB[0]), vout: 0, sats: '100000' }] });
  // a seat that holds no record of this federation and lists nothing: what it serves after the pass is what it was handed
  const blank = await door(seats(true)[4], BASE + 6);
  // and a seat that hands other bytes under the true hash: they are a copy of nothing
  const swapper = await door(a[4], BASE + 7, { swap: true });
  const first = await arbiterPass([BASE + 7, BASE + 4, BASE + 5, BASE + 3, BASE + 6]);
  const handled = () => { try { return JSON.parse(readFileSync(join(dir, 'arbiter.json'), 'utf8')).handled; } catch { return {}; } };
  const postedHere = () => Object.entries(handled()).filter(([, v]) => v.posted);
  const [slashId, slash] = postedHere()[0] || [];
  ask('the service ran its pass', first.code === 0, `exit ${first.code}`);
  if (first.code !== 0 || !slash) console.log(first.log.slice(-3000));
  ask('a record cut under its threshold is refused by name, and does not stand in for the true one', /does not stand: \d of its bonded guardians signed it/.test(first.log) && !!slash, (first.log.match(/does not stand[^"]*/) || [''])[0]);
  ask('other bytes under the true hash are no copy of anything: the seat is passed over by name', /lists that proof and hands other bytes/.test(first.log) && !!slash, (first.log.match(/lists that proof[^"]*/) || [''])[0]);
  ask('a row nobody filed, under a true record, is not slashed', /no ABANDONED row for that node/.test(first.log) && !handled()[falseId] && !!cli('gettxout', postedB[0].txid, '0'), `${postedHere().length} posted, b0's bond unspent`);
  ask('path B of the output left is posted, 5 of 7 signing', !!slash && !!slash.posted && slash.signers === 5 && slash.offence === 'ABANDONED' && slash.bondSpent === true, slash ? `${slash.posted.slice(0, 16)}, ${slash.signers} signers, ${slash.bondSats} sat, spend read off the chain: ${slash.bondSpent}` : 'none');
  rt.mine(1);
  if (!slash) throw new Error('nothing was posted');
  const slashTx = JSON.parse(cli('getrawtransaction', slash.posted, '1'));
  const opReturn = slashTx.vout[0].scriptPubKey.hex.slice(4), set = arbitrationMembers('regtest'), escrow = escrowOutput({ arbitrationKeys: set.keys, k: set.k }, { tweakPoint, combine });
  ask('it is mined, spending that output', slashTx.confirmations === 1 && slashTx.vin.length === 1 && slashTx.vin[0].txid === leftB3.txid && slashTx.vin[0].vout === 0, `${slashTx.confirmations} confirmation, input ${slashTx.vin[0].txid.slice(0, 16)}`);
  ask('OP_RETURN carries the hash of the proof, then slash_height, then the federation', opReturn.slice(0, 64) === slashId && opReturn.slice(0, 64) !== toHex(gb.proofRef) && parseInt(opReturn.slice(64, 72), 16) === slash.slashHeight && opReturn.slice(72) === toHex(FED2) && slashTx.locktime === slash.slashHeight, `${opReturn.slice(0, 16)}, height ${slash.slashHeight}, ${opReturn.slice(72, 88)}`);
  ticket = '#1062';
  // ANYONE, with the transaction and a seat's address: what the chain committed to, fetched by that hash, and checked on this reader's own census
  const committed = arbitrationCommitmentIn([{ script: fromHex(slashTx.vout[0].scriptPubKey.hex) }]), bytes = await fetched(BASE + 3, toHex(committed.proofId));
  ask('the bytes come back by that hash from the door that lists them', !!bytes && toHex(abandonedProofId(bytes)) === opReturn.slice(0, 64), bytes ? `${bytes.length} bytes` : 'none');
  const named = decodeAbandonedProof(bytes), evidence = named.record, atRecord = censusAt(splitSignedRecord(evidence).record.height).entries;
  ask('the proof names the federation, the node, the proof_ref and the output, and carries the signed record', toHex(named.federationId) === toHex(FED2) && toHex(named.nodePubkey) === toHex(others[3].pubkey) && toHex(named.proofRef) === toHex(gb.proofRef) && toHex(named.txid) === outpoint(leftB3) && named.vout === 0 && splitSignedRecord(evidence).signatures.length >= 3, `${bytes.length} bytes, record ${evidence.length} bytes, ${splitSignedRecord(evidence).signatures.length} signatures, node ${toHex(named.nodePubkey).slice(0, 16)}`);
  const beforeSlash = censusAt(spentAt);
  const decided = await decideReturn({ start: { proofId: committed.proofId }, startHeight: rt.height(), bondMaturity: 0, returnBlocks: 1, tip: rt.height() + 1, fetchProof: (id) => fetched(BASE + 4, toHex(id)),
    proofChecks: proofChecksOf({ replay: async () => false, abandoned: (b) => abandonedProofChecks({ bytes: b, nodePubkey: others[3].pubkey, bond: { txid: fromHex(outpoint(leftB3)), vout: 0 }, bonds: bondsOf(beforeSlash), censusAt: async () => atRecord, networkId: NETWORK_ID_REGTEST, inviteFederationId }) }) });
  ask('hold-return reads that commitment and leaves the slash alone: the hash checks, and so does the proof', decided.action === 'keep', `${decided.action}: ${decided.why}`);
  const rehearsal14 = await decideReturn({ start: { proofId: gb.proofRef }, startHeight: rt.height(), bondMaturity: 0, returnBlocks: 1, tip: rt.height() + 1, fetchProof: (id) => fetched(BASE + 3, toHex(id)), proofChecks: async () => true });
  ask('a bare proof_ref in the field, as #1059 had it, is what the node takes its return on', rehearsal14.action === 'return', `${rehearsal14.action}: ${rehearsal14.why}`);
  const everywhere = await Promise.all([BASE + 3, BASE + 4, BASE + 5, BASE + 6].map((port) => fetched(port, slashId)));
  ask('the service handed the proof to every seat before it posted', everywhere.every((x) => x && toHex(x) === toHex(bytes)) && slash.proofHeldBy >= 4, `${slash.proofHeldBy} seats took it`);
  ticket = '#1065';
  ask('a seat that held nothing serves the very bytes: PUT is what makes it retrievable', !!everywhere[3] && toHex(everywhere[3]) === toHex(bytes), everywhere[3] ? `${everywhere[3].length} bytes` : 'none');
  const copyOfNothing = await fetch(`http://127.0.0.1:${BASE + 3}/slash/${slashId}`, { method: 'PUT', body: encodeAbandonedProof({ ...named, record: cutRecord(named.record) }) });
  ask('a seat refuses other bytes under that hash', copyOfNothing.status === 409, `${copyOfNothing.status} ${(await copyOfNothing.text()).slice(0, 60)}`);
  ticket = '#1059';
  ask('one output: the liquidation escrow, the whole output less the fee', slashTx.vout.length === 2 && slashTx.vout[1].scriptPubKey.hex === toHex(escrow.script) && Math.round(slashTx.vout[1].value * 1e8) === 18000, `${Math.round(slashTx.vout[1].value * 1e8)} sat`);
  const second = await arbiterPass([BASE + 3]);
  const unspentEscrow = cli('gettxout', slash.posted, '1');
  ask('a second pass posts nothing and pays nothing: the escrow waits for the federation\'s end', second.code === 0 && !!unspentEscrow && postedHere().length === 1, `exit ${second.code}, ${postedHere().length} posted, escrow unspent: ${!!unspentEscrow}`);
  const event = events.map((x) => x.event).find((x) => x.proof === slashId);
  ask('its event names the proof\'s hash, the federation and the proof_ref, and says the escrow holds it', !!event && event.federation === toHex(FED2) && event.proofRef === toHex(gb.proofRef) && /escrow/.test(event.status), event ? event.status : 'no event');
  ask('the money bonded after the spend and b2\'s bond are untouched', !!cli('gettxout', lateB3.txid, '0') && !!cli('gettxout', postedB[2].txid, '0'), 'both unspent');
  rt.mine(12);
  basisTip();
  const after = (await a[4].abandonedSlashes()).filter((x) => x.federation === toHex(FED2));
  ask('once the slash is in the census read, nothing is listed', after.length === 0, `${after.length} rows`);
  ticket = '#1062';
  const later = await fetched(BASE + 3, slashId);
  ask('the output spent and the listing empty, the proof is still served', !!later && toHex(abandonedProofId(later)) === slashId, later ? `${later.length} bytes` : 'none');
  honest.close(); cutter.close(); liar.close(); blank.close(); swapper.close();

  ticket = '#1063';
  const fromRecord = async (read) => { const s = seats(true, read, heldC); for (const x of s) await x.restore(inviteFederationId); return { s, gathered: await gatherAll(s, FED3) }; };
  const v1 = await fromRecord(censusV1);
  const atOne = heldBy(v1.s[8], FED3);
  ask('seats reading the chain at protocol 1 apply the floor per output: 80,000 sat left and ABANDONED', v1.gathered.every((x) => x.ok) && atOne.gone.length === 1 && toHex(atOne.gone[0].peerKey) === toHex(thirds[3].guardianKey), `${of(FED3, v1.s[8].list()).status}, ${atOne.gone.length} gone`);
  const read = await fromRecord(censusAt);
  const heldNow = heldBy(read.s[8], FED3), mine = nodeBondOf(censusAt(heldNow.height).entries, thirds[3].pubkey);
  ask('the read a seat makes: he still holds 80,000 sat, so he stays seated and nobody is gone', read.gathered.every((x) => x.ok) && heldNow.gone.length === 0 && !!mine && mine.bondSats === 80000n, `${of(FED3, read.s[8].list()).status}, ${heldNow.gone.length} gone, his bond ${mine ? mine.bondSats : 'none'}`);

  // THE HEIGHT READ DECIDES, THROUGH THE SEATS' OWN RECORD CODE: a point above the height these seats read signs what the old read signed, a point at it what the sum signs
  ticket = '#1064';
  const bodyOf = (s) => toHex(splitSignedRecord(fromHex(of(FED3, s.list()).record)).body);
  const gatedAt = (sumFrom) => censusBy((h) => chainCensusContract({ networkId: NETWORK_ID_REGTEST, height: h, bondMinSats: 50000n, sumFrom }));
  const above = await fromRecord(gatedAt(heldNow.height + 1)), atPoint = await fromRecord(gatedAt(heldNow.height));
  ask('seats with the point above the read: the record of the old read, byte for byte, 80,000 sat left and ABANDONED', bodyOf(above.s[8]) === bodyOf(v1.s[8]) && heldBy(above.s[8], FED3).gone.length === 1, `body ${bodyOf(above.s[8]).length / 2} bytes, point ${heldNow.height + 1}, read ${heldNow.height}`);
  ask('seats with the point at the read: the record of the sum, byte for byte, nobody gone', bodyOf(atPoint.s[8]) === bodyOf(read.s[8]) && heldBy(atPoint.s[8], FED3).gone.length === 0, `point ${heldNow.height}, read ${heldNow.height}`);
  ticket = '#1063';

  // HE SPENDS A SECOND, UNDER THE FLOOR BY THE SUM: the reader's rows on a real census, and a row below the point
  const spendC2 = pathC(forty2);
  rt.mine(1);
  const spentC2At = rt.height();
  rt.mine(12);
  basisTip();
  const under = await gatherAll(read.s, FED3), rowC = heldBy(read.s[8], FED3), goneC = rowC.gone[0];
  ask('40,000 left of 120,000: under the floor by the sum, ABANDONED from that spend', under.every((x) => x.ok) && rowC.gone.length === 1 && goneC.sinceHeight === spentC2At && toHex(goneC.proofRef) === outpoint({ txid: spendC2 }), `${of(FED3, read.s[8].list()).status}, since ${goneC && goneC.sinceHeight}`);
  const rowsC = (await read.s[8].abandonedSlashes()).filter((x) => x.federation === toHex(FED3));
  ask('the seat lists the 40,000 sat he left', rowsC.length === 1 && rowsC[0].txid === outpoint(forty3) && rowsC[0].sats === '40000', rowsC.map((x) => `${x.txid.slice(0, 16)} ${x.sats} sat`).join(', '));
  // THE HASH COVERS THE RECORD (kanban #1065), printed. A signature is not deterministic, so the same three guardians signing the same record again give other bytes: another seat's copy, and another
  // hash. That is two proofs of one offence, each whole: one bond has one start, and the one that lands is the one the holders signed
  ticket = '#1065';
  const copyA = read.s[8].recordOf(toHex(FED3)).bytes, cutA = splitSignedRecord(copyA), idOfRecord = federationRecordId(cutA.record);
  const copyB = joinSignedRecord(cutA.body, cutA.signatures.map((g) => ({ nodePubkey: g.nodePubkey, signature: schnorr.sign(idOfRecord, thirds.find((t) => toHex(t.pubkey) === toHex(g.nodePubkey)).secret) })));
  const seatB = seats(true, censusAt, [{ federation: toHex(FED3), record: toHex(copyB) }]);
  await seatB[8].restore(inviteFederationId);
  const rowsB = (await seatB[8].abandonedSlashes()).filter((x) => x.federation === toHex(FED3));
  const heldB = seatB[8].recordOf(toHex(FED3)).bytes, firstSig = (b) => toHex(splitSignedRecord(b).signatures[0].signature).slice(0, 16);
  const proofB = seatB[8].abandonedProof(rowsB[0].proof), namedB = decodeAbandonedProof(proofB);
  ask('one record under two signature sets, two seats: two hashes, and each is whole on its own bytes', toHex(heldB) !== toHex(copyA) && rowsB.length === 1 && rowsB[0].proof !== rowsC[0].proof && toHex(namedB.record) === toHex(heldB) && toHex(abandonedProofId(proofB)) === rowsB[0].proof, `seat A signature ${firstSig(copyA)} hash ${rowsC[0].proof}, seat B signature ${firstSig(heldB)} hash ${rowsB[0] && rowsB[0].proof}`);
  rt.mine(12);
  basisTip();
  await gatherAll(read.s, FED3);
  const copyLater = read.s[8].recordOf(toHex(FED3)).bytes, heightLater = splitSignedRecord(copyLater).record.height, rowsLater = (await read.s[8].abandonedSlashes()).filter((x) => x.federation === toHex(FED3));
  ask('a later record holding the row: this seat keeps the proof it listed', heightLater > rowC.height && rowsLater.length === 1 && rowsLater[0].proof === rowsC[0].proof, `record at ${rowC.height} hash ${rowsC[0].proof}, record at ${heightLater} hash ${rowsLater[0] && rowsLater[0].proof}`);
  ticket = '#1062';
  const past = seats(true, censusAt, heldC, { abandonedFrom: spentC2At + 1 });
  for (const x of past) await x.restore(inviteFederationId);
  await gatherAll(past, FED3);
  const rowPast = heldBy(past[8], FED3);
  ask('a row from before the network\'s point stands in the record and nothing lists it', rowPast.gone.length === 1 && rowPast.gone[0].sinceHeight === spentC2At && (await past[8].abandonedSlashes()).filter((x) => x.federation === toHex(FED3)).length === 0, `${rowPast.gone.length} gone, since ${rowPast.gone[0] && rowPast.gone[0].sinceHeight}, 0 listed, point ${spentC2At + 1}`);
  const doorC = await door(read.s[8], BASE + 3);
  const heldBack = await arbiterPass([BASE + 3], { ARENA_ABANDONED_SLASH_HEIGHT: String(spentC2At + 1) });
  ask('a seat still listing it moves nothing: the service\'s point stops it, the output unspent', heldBack.code === 0 && !handled()[rowsC[0].proof] && !!cli('gettxout', forty3.txid, '0'), `exit ${heldBack.code}, 40,000 sat unspent`);
  ticket = '#1063';
  const third = await arbiterPass([BASE + 3]);
  const slashC = handled()[rowsC[0].proof];
  ask('the service reads him as a seat does, and path B takes what he left', third.code === 0 && !!slashC && !!slashC.posted && slashC.bondSpent === true && slashC.bondSats === '40000', slashC ? `${slashC.posted.slice(0, 16)}, ${slashC.bondSats} sat, escrow ${slashC.escrowSats}` : third.log.slice(-1500));
  doorC.close();
  rt.mine(1);
  // WHAT A ROUND READS DID NOT MOVE: the same blocks through this tree and the tree before the fix, byte for byte, at versions either side of the sum
  ask('a round at protocol 1 or 18 keeps the floor per output: his 40,000 sat outputs were never in it', [1, 18].every((v) => !censusBy(roundAt(v))(spentAt - 1).entries.some((e) => toHex(e.pubkey) === toHex(thirds[3].pubkey))), 'protocols 1 and 18');
  // EITHER SIDE OF THE POINT, on the real chain: three 40,000 sat outputs unspent at both heights
  ticket = '#1064';
  const POINT = spentAt - 1, gated = censusBy((h) => chainCensusContract({ networkId: NETWORK_ID_REGTEST, height: h, bondMinSats: 50000n, sumFrom: POINT })), never = censusBy((h) => chainCensusContract({ networkId: NETWORK_ID_REGTEST, height: h, bondMinSats: 50000n, sumFrom: null }));
  const reads = (c) => JSON.stringify([c.entries, c.excluded, c.root], (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v));
  const c3Is = (c) => { const b = nodeBondOf(c.entries, thirds[3].pubkey); return b ? `${b.bondSats} sat` : 'out'; };
  ask('below the point the census is the old read, byte for byte: 40,000 sat three times is out', reads(gated(POINT - 1)) === reads(censusV1(POINT - 1)) && c3Is(gated(POINT - 1)) === 'out', `height ${POINT - 1}: ${c3Is(gated(POINT - 1))}`);
  ask('at the point it is the sum, byte for byte: one node of 120,000', reads(gated(POINT)) === reads(censusAt(POINT)) && c3Is(gated(POINT)) === '120000 sat', `height ${POINT}: ${c3Is(gated(POINT))}`);
  ask('a network that names no point, testnet4 today, reads as before at every height', reads(never(rt.height())) === reads(censusV1(rt.height())), `height ${rt.height()}`);
  ticket = '#1063';
  if (env.GS_OLD_TREE) {
    const { censusOfView: older } = await import(join(env.GS_OLD_TREE, 'packages/arena-node/src/roster.js'));
    const flat = (c) => JSON.stringify(c, (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v));
    const same = [1, 18, 19, 22, 26].flatMap((v) => [spentAt - 1, rt.height()].map((h) => { const c = { ...roundAt(v)(h) }, view = rt.blocksFrom(0, h); return flat(censusOfView(view, c, { network: 'regtest' })) === flat(older(view, c, { network: 'regtest' })); }));
    ask('a round\'s census is byte for byte what the tree before this fix reads, at protocols 1, 18, 19, 22 and 26', same.every(Boolean), `${same.filter(Boolean).length} of ${same.length} reads`);
  }
} catch (e) { wrong += 1; console.error(`${ticket} stopped: ${e.stack}`); }
try { cli('stop'); } catch { /* gone */ }
await wait(2000);
if (bitcoind && bitcoind.exitCode === null) bitcoind.kill('SIGTERM');
if (env.GS_KEEP !== '1') rmSync(dir, { recursive: true, force: true });
console.log(wrong ? `${ticket} ${wrong} wrong` : `${ticket} all as expected`);
process.exit(wrong ? 1 : 0);
