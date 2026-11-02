#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GUARDIAN TAKES HIS MATURE BOND BY PATH A WHILE SEATED (spec 23A.5, kanban #1054). A private regtest, never testnet4, never a live seat. Four bonded guardians, each with the record code a seat
// runs (federation-records.js) over the census of the real chain, signatures asked of one another in process. A real recovery spend is mined, and the record every seat signs has him ABANDONED
// from that block, under that txid. The same seats reading no spend are run beside it: that is the record as it was before. One line per question; exits 1 if any differs.
//
//   node tools/guardian-bond-spent-regtest.mjs            (from packages/arena-node; GS_DIR, GS_BASE_PORT, BITCOIN_BIN)
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { regtest } from './regtest-bond.mjs';
import { censusOfView } from '../src/roster.js';
import { federationRecords } from '../src/federation-records.js';
import { withdrawSpend } from '../src/bond-withdraw.js';
import { splitSignedRecord } from '../../arena-protocol/src/federation-record.js';
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
let wrong = 0;
const ask = (label, ok, said = '') => { if (!ok) wrong += 1; console.log(`#1054 ${ok ? 'as expected' : 'WRONG      '} | ${label}${said === '' ? '' : ` | ${said}`}`); };

const FED = new Uint8Array(32).fill(0x37), INVITE = `fed:${toHex(FED)}`, inviteFederationId = (inv) => fromHex(String(inv).split(':')[1]);
const nodes = Array.from({ length: 4 }, (_, i) => { const secret = new Uint8Array(32).fill(0x20 + i); return { secret, pubkey: schnorr.getPublicKey(secret), guardianKey: Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]), endpoint: `http://seat-${i}.invalid` }; });
let tip = 0, rt = null;
const censusAt = (h) => { const c = censusOfView(rt.blocksFrom(0, h), { networkId: NETWORK_ID_REGTEST, censusHeight: h, censusConfirmations: 1, bondMinSats: 50000n, protocolVersion: PROTOCOL_VERSION }, { network: 'regtest' }); if (!c.ok) throw new Error(c.why); return c; };

/** Four seats, as server.js wires them: `reading` false leaves spendsAt out, which is what a seat did before. */
function seats(reading) {
  const list = nodes.map((n) => federationRecords({ round: { pubkey: n.pubkey, identity: { secret: n.secret } }, newest: () => null, roster: { censusFor: () => ({ ok: false, why: 'none' }) }, inviteFor: () => INVITE, networkId: NETWORK_ID_REGTEST,
    censusAt: async (h) => censusAt(h).entries, chainTip: async () => tip, ...(reading ? { spendsAt: async (h) => censusAt(h).excluded.filter((x) => x.spentBy) } : {}),
    fetcher: async (u) => {
      const j = list[nodes.findIndex((m) => u.startsWith(m.endpoint))], q = new URL(u);
      const body = await j.mySignature(q.searchParams.get('federation'), Number(q.searchParams.get('height')), q.searchParams.get('reserve'));
      return new Response(JSON.stringify(body), { status: body.ok ? 200 : 404 });
    } }));
  return list;
}
const gatherAll = async (list) => { const out = []; for (const s of list.filter((_, i) => i !== 3)) out.push((await s.gatherAll(inviteFederationId))[0]); return out; };
const heldBy = (s) => splitSignedRecord(fromHex(s.list()[0].record)).record;

let bitcoind = null;
try {
  bitcoind = spawn(join(BIN, 'bitcoind'), ['-regtest', `-datadir=${RT}`, `-rpcport=${RPC}`, `-port=${P2P}`, '-listen=0', '-listenonion=0', '-txindex=1', '-fallbackfee=0.0001', '-server=1'], { stdio: 'ignore' });
  for (let t = 0; t < 60; t++) { try { cli('listwallets'); break; } catch { await wait(500); } }
  try { cli('createwallet', 'arena'); } catch { /* there */ }
  rt = regtest(cli);
  rt.mine(110);
  const posted = nodes.map((n, i) => rt.postBond(n.secret, { endpoint: n.endpoint.replace('http', 'ws'), bondSats: 100000n, fundBtc: '0.02', protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS], operatorId: `op${i}`, guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] }));
  rt.include(posted.map((p) => p.hex));
  rt.mine(12);
  const a = seats(true), old = seats(false);
  const basisTip = () => { tip = rt.height() + 6; };   // a record's census height is six below the tip, on a multiple of six
  basisTip();
  for (const s of [...a, ...old]) { const [got] = await s.gatherAll(inviteFederationId); if (!got.ok) throw new Error(got.why); }
  const before = heldBy(a[0]);
  ask('four bonded guardians sign one record, all seated', before.nominal === 4 && before.gone.length === 0, `nominal ${before.nominal}, threshold ${before.threshold}, cap ${before.exposureCapSats} sat, height ${before.height}`);

  const p = posted[3];
  rt.mine(Math.max(0, p.maturity + 1 - rt.height()));
  const spend = withdrawSpend({ bond: { txid: p.txid, vout: 0, sats: String(p.bondSats), maturity: p.maturity, template: 2 }, nodeSecret: nodes[3].secret, network: 'regtest', script: rt.payTo() });
  const txid = cli('sendrawtransaction', spend.hex);
  rt.mine(1);
  const spentAt = rt.height();
  ask('a real path A spend of his mature bond is mined', JSON.parse(cli('getrawtransaction', txid, '1')).confirmations === 1, `${txid.slice(0, 16)} at ${spentAt}`);
  rt.mine(12);
  basisTip();

  const said = await gatherAll(a);
  ask('every seat gathers it: three signers of a nominal four', said.every((x) => x.ok && x.signers === 3), said.map((x) => `${x.status}, ${x.signers} signers`).join(' / '));
  const r = heldBy(a[0]);
  ask('the census dropped him, and the record keeps him listed', r.nominal === 4 && r.threshold === 3 && r.guardians.length === 4, `nominal ${r.nominal}, threshold ${r.threshold}, ${r.guardians.length} listed`);
  const g = r.gone[0];
  ask('ABANDONED from the spend\'s block', r.gone.length === 1 && toHex(g.peerKey) === toHex(nodes[3].guardianKey) && g.kind === 2 && g.sinceHeight === spentAt, `since ${g && g.sinceHeight}, kind ${g && g.kind}`);
  ask('proof_ref is that spend\'s txid', !!g && toHex(g.proofRef) === toHex(Uint8Array.from(fromHex(txid)).reverse()), g ? toHex(g.proofRef).slice(0, 16) : '');
  ask('the federation counts him gone at once', a[0].list()[0].status === 'CRITICAL', a[0].list()[0].status);

  const was = await gatherAll(old);
  const o = heldBy(old[0]);
  ask('seats that read no spend: the record as it was, a shrunk nominal and nobody gone', was.every((x) => x.ok) && o.nominal === 3 && o.gone.length === 0, `${old[0].list()[0].status}, nominal ${o.nominal}, threshold ${o.threshold}, gone ${o.gone.length}`);
} catch (e) { wrong += 1; console.error(`#1054 stopped: ${e.stack}`); }
try { cli('stop'); } catch { /* gone */ }
await wait(2000);
if (bitcoind && bitcoind.exitCode === null) bitcoind.kill('SIGTERM');
if (env.GS_KEEP !== '1') rmSync(dir, { recursive: true, force: true });
console.log(wrong ? `#1054 ${wrong} wrong` : '#1054 all as expected');
process.exit(wrong ? 1 : 0);
