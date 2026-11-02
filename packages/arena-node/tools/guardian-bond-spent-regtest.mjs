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
import { joinSignedRecord, splitSignedRecord } from '../../arena-protocol/src/federation-record.js';
import { bondsOf } from '../../arena-protocol/src/abandoned-slash.js';
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

const FED = new Uint8Array(32).fill(0x37), FED2 = new Uint8Array(32).fill(0x38);
const inviteOf = (id, at) => inviteForGuardians(id, [{ url: `ws://${at}.invalid`, peer: 0 }]);
const INVITES = new Map([[toHex(FED), inviteOf(FED, 'guardian-a')], [toHex(FED2), inviteOf(FED2, 'guardian-b')]]);
const inviteFederationId = (inv) => fromHex(readInvite(inv).federationId);
const fourOf = (fed, secretByte, keyByte, name) => Array.from({ length: 4 }, (_, i) => { const secret = new Uint8Array(32).fill(secretByte + i); return { fed, secret, pubkey: schnorr.getPublicKey(secret), guardianKey: Uint8Array.from([2, ...new Uint8Array(32).fill(keyByte + i)]), endpoint: `http://seat-${name}${i}.invalid` }; });
const nodes = fourOf(FED, 0x20, 0x60, 'a'), others = fourOf(FED2, 0x30, 0x70, 'b'), everyone = [...nodes, ...others];
let tip = 0, rt = null;
const SLACK = 60;   // each funding mines blocks, so a bond posted first must still count as confirmed in time with eleven more behind it
const censusAt = (h) => { const c = censusOfView(rt.blocksFrom(0, h), { networkId: NETWORK_ID_REGTEST, censusHeight: h, censusConfirmations: 1, bondMinSats: 50000n, protocolVersion: PROTOCOL_VERSION }, { network: 'regtest' }); if (!c.ok) throw new Error(c.why); return c; };

/** Four seats, as server.js wires them: `reading` false leaves spendsAt out, which is what a seat did before. */
function seats(reading) {
  const list = everyone.map((n) => federationRecords({ round: { pubkey: n.pubkey, identity: { secret: n.secret } }, newest: () => null, roster: { censusFor: () => ({ ok: false, why: 'none' }) }, inviteFor: (fid) => INVITES.get(fid) || null, networkId: NETWORK_ID_REGTEST,
    censusAt: async (h) => censusAt(h).entries, chainTip: async () => tip, ...(reading ? { spendsAt: async (h) => censusAt(h).excluded.filter((x) => x.spentBy), bondsAt: async (h) => bondsOf(censusAt(h)) } : {}),
    fetcher: async (u) => {
      const j = list[everyone.findIndex((m) => u.startsWith(m.endpoint))], q = new URL(u);
      const body = await j.mySignature(q.searchParams.get('federation'), Number(q.searchParams.get('height')), q.searchParams.get('reserve'));
      return new Response(JSON.stringify(body), { status: body.ok ? 200 : 404 });
    } }));
  return list;
}
const of = (fed, rows) => rows.find((x) => x.federation === toHex(fed));
const gatherAll = async (list, fed = FED) => { const out = []; for (const [i, s] of list.entries()) if (i !== 3 && i !== 7) out.push(of(fed, await s.gatherAll(inviteFederationId))); return out; };
const heldBy = (s, fed = FED) => splitSignedRecord(fromHex(of(fed, s.list()).record)).record;
const outpoint = (posted) => toHex(fromHex(posted.txid).reverse());

// GET /slashes and GET /federation-records-at as server.js answers them, and the event door; `extra` adds rows nobody filed, `cut` hands every record with one signature less than its threshold
const events = [];
function door(seat, port, { extra = null, cut = false } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'), json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/slashes') return json({ slashes: [], auditSlashes: [], doubleSlashes: [], tableSlashes: [], abandonedSlashes: [...(await seat.abandonedSlashes()), ...(extra ? extra() : [])] });
    if (url.pathname === '/federation-records-at') {
      const r = seat.recordAt(url.searchParams.get('federations'), Number(url.searchParams.get('height')));
      if (!r) return json({ records: [] });
      const bytes = fromHex(r.__hex), s = splitSignedRecord(bytes);
      return json({ records: [{ federation: toHex(r.federationId), height: r.height, record: cut ? toHex(joinSignedRecord(s.body, s.signatures.slice(0, r.threshold - 1))) : r.__hex }] });
    }
    if (url.pathname === '/liquidations/events') { let b = ''; for await (const c of req) b += c; events.push(JSON.parse(b)); return json({ ok: true }); }
    res.writeHead(404); return res.end();
  });
  return new Promise((r) => { server.listen(port, '127.0.0.1', () => r(server)); });
}
/** One pass of the service itself, a process of its own, on this chain and these doors. */
const arbiterPass = (ports) => new Promise((done) => {
  const c = spawn(process.execPath, ['tools/arbiter.mjs', '--once'], { cwd: join(dirname(fileURLToPath(import.meta.url)), '..'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, ARENA_ARBITER_NETWORK: 'regtest', ARENA_ARBITER_SEATS: ports.map((p) => `http://127.0.0.1:${p}`).join(','), ARENA_BITCOIND_URL: `http://127.0.0.1:${RPC}`, ARENA_BITCOIND_COOKIE: join(RT, 'regtest', '.cookie'),
      ARENA_ARBITER_PORT: String(BASE + 2), ARENA_ARBITER_STATE: join(dir, 'arbiter.json') } });
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
  rt.include([...posted, ...postedB].map((p) => p.hex));
  rt.mine(1);
  // b2's second output, 60,000 sat, and b3's: he will spend his 100,000 and be left with 20,000, under the floor of 50,000
  const secondOf = (i, sats) => rt.postBond(others[i].secret, { endpoint: others[i].endpoint.replace('http', 'ws'), bondSats: sats, fundBtc: '0.02', slackBlocks: SLACK, advert: postedB[i].advert });
  const extraB2 = secondOf(2, 60000n), leftB3 = secondOf(3, 20000n);
  rt.include([extraB2.hex, leftB3.hex]);
  rt.mine(12);
  const a = seats(true), old = seats(false);
  const basisTip = () => { tip = rt.height() + 6; };   // a record's census height is six below the tip, on a multiple of six
  basisTip();
  for (const s of [...a, ...old]) for (const got of await s.gatherAll(inviteFederationId)) if (!got.ok) throw new Error(got.why);
  const before = heldBy(a[0]);
  ask('four bonded guardians sign one record, all seated', before.nominal === 4 && before.gone.length === 0, `nominal ${before.nominal}, threshold ${before.threshold}, cap ${before.exposureCapSats} sat, height ${before.height}`);

  const p = posted[3];
  rt.mine(Math.max(0, Math.max(p.maturity, postedB[3].maturity, extraB2.maturity) + 1 - rt.height()));
  const spend = withdrawSpend({ bond: { txid: p.txid, vout: 0, sats: String(p.bondSats), maturity: p.maturity, template: 2 }, nodeSecret: nodes[3].secret, network: 'regtest', script: rt.payTo() });
  const txid = cli('sendrawtransaction', spend.hex);
  const pathA = (i, bond) => cli('sendrawtransaction', withdrawSpend({ bond: { txid: bond.txid, vout: 0, sats: String(bond.bondSats), maturity: bond.maturity, template: 2 }, nodeSecret: others[i].secret, network: 'regtest', script: rt.payTo() }).hex);
  const spendB3 = pathA(3, postedB[3]), spendB2 = pathA(2, extraB2);
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
  const liar = await door(a[6], BASE + 5, { extra: () => [{ ...listed[0], proof: 'ee'.repeat(32), peer: toHex(others[0].guardianKey), node: toHex(others[0].pubkey), txid: outpoint(postedB[0]), vout: 0, sats: '100000' }] });
  const first = await arbiterPass([BASE + 4, BASE + 5, BASE + 3]);
  const handled = () => { try { return JSON.parse(readFileSync(join(dir, 'arbiter.json'), 'utf8')).handled; } catch { return {}; } };
  const slash = handled()[listed[0].proof];
  ask('the service ran its pass', first.code === 0, `exit ${first.code}`);
  if (first.code !== 0 || !slash) console.log(first.log.slice(-3000));
  ask('a record cut under its threshold is refused by name, and does not stand in for the true one', /does not stand: \d of its bonded guardians signed it/.test(first.log) && !!slash, (first.log.match(/does not stand[^"]*/) || [''])[0]);
  ask('a row nobody filed, under a true record, is not slashed', /no ABANDONED row for that peer/.test(first.log) && !handled()['ee'.repeat(32)] && !!cli('gettxout', postedB[0].txid, '0'), `${Object.keys(handled()).length} handled, b0's bond unspent`);
  ask('path B of the output left is posted, 5 of 7 signing', !!slash && !!slash.posted && slash.signers === 5 && slash.offence === 'ABANDONED' && slash.bondSpent === true, slash ? `${slash.posted.slice(0, 16)}, ${slash.signers} signers, ${slash.bondSats} sat, spend read off the chain: ${slash.bondSpent}` : 'none');
  rt.mine(1);
  if (!slash) throw new Error('nothing was posted');
  const slashTx = JSON.parse(cli('getrawtransaction', slash.posted, '1'));
  const opReturn = slashTx.vout[0].scriptPubKey.hex.slice(4), set = arbitrationMembers('regtest'), escrow = escrowOutput({ arbitrationKeys: set.keys, k: set.k }, { tweakPoint, combine });
  ask('it is mined, spending that output', slashTx.confirmations === 1 && slashTx.vin.length === 1 && slashTx.vin[0].txid === leftB3.txid && slashTx.vin[0].vout === 0, `${slashTx.confirmations} confirmation, input ${slashTx.vin[0].txid.slice(0, 16)}`);
  ask('OP_RETURN carries the same proof_ref, then slash_height, then the federation', opReturn.slice(0, 64) === toHex(gb.proofRef) && parseInt(opReturn.slice(64, 72), 16) === slash.slashHeight && opReturn.slice(72) === toHex(FED2) && slashTx.locktime === slash.slashHeight, `${opReturn.slice(0, 16)}, height ${slash.slashHeight}, ${opReturn.slice(72, 88)}`);
  ask('one output: the liquidation escrow, the whole output less the fee', slashTx.vout.length === 2 && slashTx.vout[1].scriptPubKey.hex === toHex(escrow.script) && Math.round(slashTx.vout[1].value * 1e8) === 18000, `${Math.round(slashTx.vout[1].value * 1e8)} sat`);
  const second = await arbiterPass([BASE + 3]);
  const unspentEscrow = cli('gettxout', slash.posted, '1');
  ask('a second pass posts nothing and pays nothing: the escrow waits for the federation\'s end', second.code === 0 && !!unspentEscrow && Object.keys(handled()).length === 1, `exit ${second.code}, ${Object.keys(handled()).length} handled, escrow unspent: ${!!unspentEscrow}`);
  const event = events.map((x) => x.event).find((x) => x.proof === listed[0].proof);
  ask('its event names the federation and the proof_ref, and says the escrow holds it', !!event && event.federation === toHex(FED2) && event.proofRef === toHex(gb.proofRef) && /escrow/.test(event.status), event ? event.status : 'no event');
  ask('the money bonded after the spend and b2\'s bond are untouched', !!cli('gettxout', lateB3.txid, '0') && !!cli('gettxout', postedB[2].txid, '0'), 'both unspent');
  rt.mine(12);
  basisTip();
  const after = (await a[4].abandonedSlashes()).filter((x) => x.federation === toHex(FED2));
  ask('once the slash is in the census read, nothing is listed', after.length === 0, `${after.length} rows`);
  honest.close(); cutter.close(); liar.close();
} catch (e) { wrong += 1; console.error(`${ticket} stopped: ${e.stack}`); }
try { cli('stop'); } catch { /* gone */ }
await wait(2000);
if (bitcoind && bitcoind.exitCode === null) bitcoind.kill('SIGTERM');
if (env.GS_KEEP !== '1') rmSync(dir, { recursive: true, force: true });
console.log(wrong ? `${ticket} ${wrong} wrong` : `${ticket} all as expected`);
process.exit(wrong ? 1 : 0);
