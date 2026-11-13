// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DEPARTURE ANCHOR ON A REAL BITCOIN CORE (kanban #2610): a regtest bitcoind of its own, a bond wallet in it, and the node's posting
// side (departure-anchor.js) against it - the anchor funded with walletcreatefundedpsbt from that wallet, sent, not published while in the
// mempool, confirmed, read as a seat reads it (getrawtransaction with the block hash, main.js ballot.confirmedTx), then published; a seat
// (absences.js) takes the published notice and has the guardian DEPARTED from leave_after. A restart from the record file posts nothing new.
// KANBAN #2612: the anchor carries the whole notice (OP_RETURN "ARN" 'L' || notice || signature, 176 bytes) - Core's testmempoolaccept takes
// it under its default policy, a seat that was never told reads it off the raw block (scanDepartures), and the #2608 hash-only form, mined,
// gives no notice and no anchor height.
//
//   BITCOIN_BIN=/path/to/bin RT_DIR=/some/empty/dir node tools/departure-anchor-regtest.mjs
//
// Its own datadir and ports (RT_PORT, default 24611; RPC RT_PORT + 1); it stops the daemon at the end.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { departureAnchorScript, departureId, departureAnchorHeight, DEPARTURE_ANCHOR_SLACK, departuresInBlock } from '../../arena-protocol/src/absence.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { createAbsences, readDepartureHex, departureHex } from '../src/absences.js';
import { ownDeparture } from '../src/absence-producer.js';
import { bondCliFrom } from '../src/add-bond-wallet.js';
import { createDepartureAnchors, bondCliAnchorWallet, fileStore } from '../src/departure-anchor.js';

const BIN = process.env.BITCOIN_BIN; const DIR = process.env.RT_DIR; const PORT = Number(process.env.RT_PORT || 24611);
if (!BIN || !DIR) { console.error('BITCOIN_BIN and RT_DIR, please'); process.exit(2); }
mkdirSync(DIR, { recursive: true });
const base = [`-regtest`, `-datadir=${DIR}`, `-rpcport=${PORT + 1}`];
const node = (...a) => execFileSync(join(BIN, 'bitcoin-cli'), [...base, ...a], { encoding: 'utf8' }).trim();
const say = (k, v) => console.log(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); process.exitCode = 1; throw new Error(m); } say('ok', m); };

const d = spawn(join(BIN, 'bitcoind'), [...base, `-port=${PORT}`, '-listen=0', '-fallbackfee=0.0001', '-txindex=0'], { stdio: 'ignore' });
try {
  for (let i = 0; ; i++) { try { node('getblockcount'); break; } catch { if (i > 60) throw new Error('bitcoind did not come up'); await new Promise((r) => setTimeout(r, 500)); } }
  try { node('createwallet', 'bonds'); } catch { try { node('loadwallet', 'bonds'); } catch { /* loaded */ } }
  const addr = node('-rpcwallet=bonds', 'getnewaddress');
  node('generatetoaddress', '101', addr);
  say('version', JSON.parse(node('getnetworkinfo')).subversion);
  // THE BOND WALLET AS A SEAT NAMES IT (ARENA_BOND_CLI), each wallet call counted
  const w = bondCliFrom({ ARENA_BOND_CLI: `${join(BIN, 'bitcoin-cli')} ${base.join(' ')} -rpcwallet=bonds` });
  let funds = 0; const cli = (...a) => { if (a.includes('walletcreatefundedpsbt')) funds++; return w.cli(...a); };
  // THE NODE'S CHAIN, as server.js hands it (chainTip, ballot.blockHashAt, chainBlockTxids) and the seat's reader (main.js ballot.confirmedTx)
  const chain = { tip: async () => Number(node('getblockcount')),
    blockAt: async (h) => { try { const hash = node('getblockhash', String(h)); return { hash, txids: JSON.parse(node('getblock', hash, '1')).tx }; } catch { return null; } } };
  const confirmedTx = async (txid, blockHash) => { try { const head = JSON.parse(node('getblockheader', blockHash)); if (!(head.confirmations >= 1)) return null;
    return { raw: fromHex(node('getrawtransaction', txid, 'false', blockHash)), height: head.height }; } catch { return null; } };

  const secret = new Uint8Array(32).fill(5); const pub = schnorr.getPublicKey(secret);
  const FED = new Uint8Array(32).fill(0x61); const peer = Uint8Array.from([2, ...new Uint8Array(32).fill(0x62)]);
  const NOTICE = 6;                                  // regtest's departure_notice is short; the rule is the same
  const tip = await chain.tip();
  const gate = departureAnchorHeight('regtest');
  const notice = ownDeparture({ own: { federation: toHex(FED), peerKey: peer }, tip, departureNotice: NOTICE, nodePubkey: pub, sign: (m) => schnorr.sign(m, secret), slack: DEPARTURE_ANCHOR_SLACK });
  say('notice', { id: toHex(departureId(notice)), postedAt: notice.postedAt, leaveAfter: notice.leaveAfterHeight, gate });
  const file = join(DIR, 'departure-anchors.json');
  const published = [];
  const mk = () => createDepartureAnchors({ wallet: bondCliAnchorWallet(cli), chain, confirmedTx, store: fileStore(file, { readFileSync, writeFileSync, renameSync }),
    publish: async (x) => { published.push(departureHex(x)); return { postedTo: 1, of: 1 }; }, log: (l) => console.log(l) });
  const a = mk();
  const t0 = Date.now();
  const r = await a.anchor(notice);
  say('sent', r);
  const raw = node('getrawtransaction', r.txid);
  const out = parseTransaction(fromHex(raw)).outputs.find((o) => o.script[0] === 0x6a);
  ok(out && toHex(out.script) === toHex(departureAnchorScript(notice)), `the transaction carries ${toHex(departureAnchorScript(notice))}`);
  ok(JSON.parse(node('getrawmempool')).includes(r.txid), 'in the mempool');
  await a.pass();
  ok(published.length === 0, 'not published while unconfirmed');
  const mined = JSON.parse(node('generatetoaddress', '1', addr))[0];
  const [p] = await a.pass();
  say('confirmed', { ...p, ms: Date.now() - t0 });
  ok(p.phase === 'published' && p.blockHash === mined && published.length === 1, 'published once confirmed, with its block hash');
  // A SEAT takes the published bytes, reads the anchor on its own chain
  const seat = createAbsences({ verify: (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } }, confirmedTx, anchorGate: gate });
  const took = await seat.offerAnchored(readDepartureHex(published[0]));
  ok(took.ok, 'the seat took it');
  const record = { federationId: FED, nominal: 4, guardians: [{ peerKey: peer, nodePubkey: pub }] };
  const due = seat.departureFor(record, peer, NOTICE, notice.leaveAfterHeight);
  ok(due.ok && due.sinceHeight === notice.leaveAfterHeight, `DEPARTED from ${notice.leaveAfterHeight} (anchor at ${p.height})`);
  ok(!seat.departureFor(record, peer, NOTICE, p.height + NOTICE - 1).ok, 'not before anchor + departure_notice');
  // A RESTART: a new process from the same file - asked again, it funds nothing and publishes nothing new
  const b = mk();
  const again = await b.anchor(notice); await b.pass();
  ok(again.txid === r.txid && funds === 1 && published.length === 1, `restart: the same anchor ${r.txid.slice(0, 16)}, funded ${funds} time(s), published ${published.length} time(s)`);
  say('fee', `${r.feeSats} sat`);
  const vt = JSON.parse(node('decoderawtransaction', raw));
  say('anchor tx', { vsize: vt.vsize, opReturnScriptBytes: out.script.length, policy: 'default (no -datacarriersize given)' });
  // A SEAT THAT WAS NEVER TOLD (#2612): it reads every block from the gate on, as main.js serves them (getblock verbosity 0)
  const scanner = { tipHeight: chain.tip, blockHashAt: async (h) => { try { return node('getblockhash', String(h)); } catch { return null; } },
    departuresAt: async (h, hash) => departuresInBlock(fromHex(node('getblock', hash, '0')), h) };
  const blind = createAbsences({ verify: (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } }, confirmedTx, anchorGate: gate });
  let found = 0, read = 0;
  for (;;) { const x = await blind.scanDepartures(scanner, { max: 500 }); found += x.found; read += x.took; if (x.to === null || x.to >= await chain.tip()) break; }
  ok(found === 1 && read === 1, `a seat never told read the notice off block ${p.height} (found ${found}, took ${read})`);
  ok(blind.departureNotices()[0].anchor.height === p.height, 'at the anchor\'s height');
  ok(blind.departureFor(record, peer, NOTICE, notice.leaveAfterHeight).ok, 'DEPARTED from leave_after on the chain read alone');
  // THE #2608 FORM (a hash only), mined: no notice on chain, no anchor height from it
  const n2 = ownDeparture({ own: { federation: toHex(FED), peerKey: peer }, tip: await chain.tip(), departureNotice: NOTICE, nodePubkey: pub, sign: (m) => schnorr.sign(m, secret), slack: DEPARTURE_ANCHOR_SLACK });
  const f2 = JSON.parse(cli('-named', 'walletcreatefundedpsbt', 'inputs=[]', `outputs=${JSON.stringify([{ data: `41524e4c${toHex(departureId(n2))}` }])}`, `options=${JSON.stringify({ fee_rate: 2 })}`));
  const h2 = JSON.parse(cli('finalizepsbt', JSON.parse(cli('walletprocesspsbt', f2.psbt)).psbt)).hex;
  const t2 = cli('sendrawtransaction', h2);
  const b2 = JSON.parse(node('generatetoaddress', '1', addr))[0];
  const x2 = await blind.scanDepartures(scanner);
  ok(departuresInBlock(fromHex(node('getblock', b2, '0')), 0).length === 0 && x2.took === 0, `the hash-only anchor ${t2.slice(0, 16)} mined: no notice in its block, nothing taken`);
  const shown = await blind.anchorDeparture({ ...n2, anchor: { txid: t2, blockHash: b2 } });
  ok(!Number.isInteger(shown.anchor.height), 'shown later with that transaction: no anchor height');
  ok(!blind.departureFor(record, peer, NOTICE, n2.leaveAfterHeight + 10).ok || blind.departureFor(record, peer, NOTICE, n2.leaveAfterHeight + 10).notice.leaveAfterHeight === notice.leaveAfterHeight, 'the hash-only notice never becomes the departure');
} finally {
  try { node('stop'); } catch { d.kill(); }
}
