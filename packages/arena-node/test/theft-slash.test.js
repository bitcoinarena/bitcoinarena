// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT ON A MARK OF THEFT (kanban #1093 part 2, rulings #1106, #1109). With a standing alarm in its own book it holds a TheftProof - the signed record and the whole session history - for every
// template-3 output of every guardian the record still seats, and none without one. It judges such a proof on its bytes alone: its own census, its own chain, its own session verifier, never
// its alarm book; where it has no verifier it says nothing (undefined), so no hold's return is taken on a guess. The judge and a hold's return route the proof to that word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { federationRecords } from '../src/federation-records.js';
import { createProofJudge } from '../src/proof-judge.js';
import { proofChecksOf } from '../src/hold-return.js';
import { theftTools } from '../src/theft-evidence.js';
import { buildFederationRecord, encodeFederationRecord, federationRecordId, joinSignedRecord, GONE } from '../../arena-protocol/src/federation-record.js';
import { decodeTheftProof, encodeTheftProof, theftProofId } from '../../arena-protocol/src/theft-slash.js';
import { encodeAbandonedProof } from '../../arena-protocol/src/abandoned-slash.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const FED = new Uint8Array(32).fill(0x37), INVITE = `fed:${toHex(FED)}`, inviteFederationId = (inv) => fromHex(String(inv).split(':')[1]);
const HEIGHT = 306, TIP = 340;
const nodes = Array.from({ length: 4 }, (_, i) => { const secret = new Uint8Array(32).fill(0x20 + i); return { secret, pubkey: schnorr.getPublicKey(secret), guardianKey: Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]) }; });
const advertOf = (n, i) => ({ nodePubkey: n.pubkey, operatorId: `op${i}`, bondScriptTemplateVersion: 3, bondMaturityHeight: 900, endpoint: `wss://seat-${i}.example`, guardianEndpoint: `wss://g${i}.example`, guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] });
const census = nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xa0 + i), vout: 0, bondSats: 100000n, height: 120, advert: advertOf(n, i) }));
// a second output of node 0, and node 3 DEPARTED by notice: it is not taken
const EXTRA = { pubkey: nodes[0].pubkey, txid: new Uint8Array(32).fill(0xb0), vout: 1, bondSats: 30000n, height: 150, advert: advertOf(nodes[0], 0) };
function signed({ gone = [{ peerKey: nodes[3].guardianKey, sinceHeight: 300, kind: GONE.DEPARTED, proofRef: new Uint8Array(32) }], signers = nodes.slice(0, 3) } = {}) {
  const guardians = nodes.map((n, i) => ({ nodePubkey: n.pubkey, peerKey: n.guardianKey, operatorId: `op${i}`, bondTxid: new Uint8Array(32).fill(0xa0 + i), bondVout: 0, bondSats: 100000n, endpoint: `wss://g${i}.example` }));
  const record = buildFederationRecord({ federationId: FED, networkId: NETWORK_ID_REGTEST, invite: INVITE, nominal: 4, guardians, gone, height: HEIGHT, reserveSats: 0n });
  return joinSignedRecord(encodeFederationRecord(record), signers.map((n) => ({ nodePubkey: n.pubkey, signature: schnorr.sign(federationRecordId(record), n.secret) })));
}
const SIGNED = signed();
const ALARM = { federation: toHex(FED), kind: 'inflation', height: 330, session: 4, state: 'CONFIRMED' };   // kanban #1176: only a CONFIRMED alarm files slashes
const sessions = Array.from({ length: 5 }, (_, i) => Uint8Array.of(0xee, i));
const EVIDENCE = { mark: { kind: 'inflation', height: 330, session: 4 }, config: Uint8Array.of(7, 7), firstSession: 0, sessions };
const answer = (input, over = {}) => ({ mode: 'theft-verify', federationMatches: input.federationId === toHex(FED), sessions: input.sessions.length, verified: input.sessions.length, unverified: [],
  firstSession: input.firstSession, lastSession: input.firstSession + input.sessions.length - 1, firstInflationSession: 4, cumulativeIssuedMsat: 1000, cumulativeRedeemedMsat: 1200, signedPegOutTxids: [], ...over });

function seat({ alarm = ALARM, bonds = async () => [...census, EXTRA], verifySessions = async (input) => answer(input), evidence = async () => EVIDENCE, record = SIGNED, ...over } = {}) {
  const n = nodes[0];
  return federationRecords({ round: { pubkey: n.pubkey, identity: { secret: n.secret }, db: { prepare: () => ({ all: () => [], get: () => ({ m: 0 }) }) } }, roster: { censusFor: () => ({ ok: false, why: 'none' }) }, inviteFor: () => null, networkId: NETWORK_ID_REGTEST,
    censusAt: async () => census, chainTip: async () => TIP, bondsAt: bonds, store: { load: () => [{ federation: toHex(FED), record: toHex(record) }], save: () => {} },
    alarmOf: (fid) => (alarm && fid === toHex(FED) ? alarm : null), theftEvidenceOf: evidence, verifySessions, ...over });
}

test('a standing alarm: one TheftProof per template-3 output of every seated guardian, the departed one left out; no alarm, none', async () => {
  const s = seat();
  await s.restore(inviteFederationId);
  const rows = await s.theftSlashes();
  assert.deepEqual(rows.map((r) => [r.node, r.txid, r.vout, r.sats, r.kind, r.recordHeight]).sort(), [
    [toHex(nodes[0].pubkey), toHex(census[0].txid), 0, '100000', 'inflation', HEIGHT], [toHex(nodes[0].pubkey), toHex(EXTRA.txid), 1, '30000', 'inflation', HEIGHT],
    [toHex(nodes[1].pubkey), toHex(census[1].txid), 0, '100000', 'inflation', HEIGHT], [toHex(nodes[2].pubkey), toHex(census[2].txid), 0, '100000', 'inflation', HEIGHT]].sort());
  const bytes = s.theftProof(rows[0].proof);
  assert.equal(toHex(theftProofId(bytes)), rows[0].proof, 'served under its hash');
  const p = decodeTheftProof(bytes);
  assert.deepEqual([toHex(p.record), p.sessions.length, p.firstSession, p.mark.session], [toHex(SIGNED), 5, 0, 4], 'the record and the whole history are in the bytes');
  assert.deepEqual((await s.theftSlashes()).map((r) => r.proof), rows.map((r) => r.proof), 'listed under the first proof built, every pass');

  const none = seat({ alarm: null });
  await none.restore(inviteFederationId);
  assert.deepEqual(await none.theftSlashes(), [], 'no alarm in this seat\'s own book: no proof');
  const raised = seat({ alarm: { ...ALARM, state: 'RAISED' } });
  await raised.restore(inviteFederationId);
  assert.deepEqual(await raised.theftSlashes(), [], 'kanban #1176: a RAISED alarm (no other seat signed the mark) files no slash');
  const noEvidence = seat({ evidence: async () => null });
  await noEvidence.restore(inviteFederationId);
  assert.deepEqual(await noEvidence.theftSlashes(), [], 'no sessions exported: nothing to file');
});

test('the judge\'s three answers, on the bytes: true where its own verifier shows the mark, false where it does not, undefined with no verifier - its alarm book is not asked', async () => {
  const builder = seat();
  await builder.restore(inviteFederationId);
  const row = (await builder.theftSlashes()).find((r) => r.node === toHex(nodes[1].pubkey));
  const bytes = builder.theftProof(row.proof);

  const checker = seat({ alarm: null });                    // a holder that never audited that federation: the bytes alone
  await checker.restore(inviteFederationId);
  const yes = await checker.theftVerdict(bytes, inviteFederationId);
  assert.equal(yes.verdict, true, yes.why);
  assert.match(yes.why, /inflation at session 4/);

  const lies = seat({ alarm: ALARM, verifySessions: async (input) => answer(input, { firstInflationSession: null }) });
  await lies.restore(inviteFederationId);
  const no = await lies.theftVerdict(bytes, inviteFederationId);
  assert.deepEqual([no.verdict, /never passes/.test(no.why)], [false, true], 'its own alarm does not stand in for the bytes');
  const forged = seat({ verifySessions: async (input) => answer(input, { unverified: [2], verified: 4 }) });
  await forged.restore(inviteFederationId);
  assert.equal((await forged.theftVerdict(bytes, inviteFederationId)).verdict, false);

  const blind = seat({ verifySessions: async () => undefined });
  await blind.restore(inviteFederationId);
  const unsure = await blind.theftVerdict(bytes, inviteFederationId);
  assert.deepEqual([unsure.verdict, /cannot verify/.test(unsure.why)], [undefined, true]);

  const started = seat({ bonds: async () => [...census.map((e) => (e.pubkey === nodes[1].pubkey ? { ...e, hold: { txid: 'x' } } : e)), EXTRA] });
  await started.restore(inviteFederationId);
  assert.equal((await started.theftVerdict(bytes, inviteFederationId)).verdict, false, 'the output read at the tip is started: read before the start, it stands');
  let readAt = null;
  const before = seat({ bonds: async (h) => { readAt = h; return [...census, EXTRA]; } });
  await before.restore(inviteFederationId);
  assert.equal((await before.theftVerdict(bytes, inviteFederationId, 334)).verdict, true);
  assert.equal(readAt, 334);

  const departed = encodeTheftProof({ federationId: FED, nodePubkey: nodes[3].pubkey, txid: census[3].txid, vout: 0, record: SIGNED, ...EVIDENCE });
  assert.match((await checker.theftVerdict(departed, inviteFederationId)).why, /does not seat that node/, 'a guardian who left by notice is not taken');
  const short = encodeTheftProof({ federationId: FED, nodePubkey: nodes[1].pubkey, txid: census[1].txid, vout: 0, record: signed({ signers: nodes.slice(0, 2) }), ...EVIDENCE });
  assert.equal((await checker.theftVerdict(short, inviteFederationId)).verdict, false, 'a record short of its threshold');
  assert.equal((await checker.theftVerdict(Uint8Array.of(0x46, 1), inviteFederationId)).verdict, false);
});

test('the proof judge reads a theft as a roundless proof and asks the theft hook, before the start\'s block; a hold\'s return routes it there too', async () => {
  const builder = seat();
  await builder.restore(inviteFederationId);
  const bytes = builder.theftProof((await builder.theftSlashes())[0].proof);
  const asked = [];
  const judge = createProofJudge({ committeeOf: () => ({ ok: false }), censusOf: () => ({ ok: false }), coreOf: () => null, beaconOf: () => ({ ok: false }), replayRunOf: () => undefined,
    abandoned: async () => ({ verdict: false, why: 'not this one' }), theft: async (b, before) => { asked.push(before); return { verdict: true, why: 'held' }; } });
  const read = judge.read(bytes);
  assert.deepEqual([read.ok, read.kind, read.roundId, read.floorHeight, read.mark.kind], [true, 'theft', null, HEIGHT, 'inflation']);
  assert.equal((await judge(bytes, { startHeight: 335 })).verdict, true);
  assert.equal((await judge(bytes)).verdict, true);
  assert.deepEqual(asked, [334, null]);
  assert.equal(judge.read(Uint8Array.of(0x46, 0)).ok, false);

  const checks = proofChecksOf({ replay: async () => 'replay', abandoned: async () => 'abandoned', theft: async () => 'theft' });
  assert.equal(await checks(bytes), 'theft');
  assert.equal(await checks(encodeAbandonedProof({ federationId: FED, nodePubkey: nodes[0].pubkey, proofRef: new Uint8Array(32).fill(1), txid: new Uint8Array(32), vout: 0, record: SIGNED })), 'abandoned');
  assert.equal(await proofChecksOf({ replay: async () => 'replay', abandoned: async () => 'abandoned' })(bytes), undefined, 'no theft check given: no word, the node stays');
});

/** A child process that prints `line` and, for an export, writes `file`. */
const fakeSpawn = (behave) => (bin, args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  let input = '';
  child.stdin = { end: (s) => { input = s || ''; setImmediate(() => { const out = behave(args, input); if (out) child.stdout.emit('data', `${out}\n`); child.emit('close', 0); }); } };
  child.kill = () => {};
  return child;
};

test('the stake-lock tool: theft-verify gets the proof on stdin; a tool without that mode gives no word; session-export builds the evidence from 0 to the mark', async () => {
  const dir = mkdtempSync(join(process.cwd(), '.theft-test-'));
  const seen = [];
  const tools = theftTools({ bin: '/bin/tool', dirOf: () => dir, spawn: fakeSpawn((args, input) => {
    seen.push(args);
    if (args[1] === 'theft-verify') return JSON.stringify(answer(JSON.parse(input)));
    const out = args[args.indexOf('--out') + 1];
    writeFileSync(out, JSON.stringify({ federationId: toHex(FED), config: '0707', firstSession: 0, sessions: sessions.map(toHex) }));
    return JSON.stringify({ mode: 'session-export', sessions: 5 });
  }) });
  const ev = await tools.theftEvidenceOf(toHex(FED), ALARM);
  assert.deepEqual([ev.mark, toHex(ev.config), ev.firstSession, ev.sessions.map(toHex)], [EVIDENCE.mark, '0707', 0, sessions.map(toHex)]);
  assert.deepEqual(seen[0].slice(0, 2), ['--mode', 'session-export']);
  assert.deepEqual(seen[0].slice(4, 8), ['--from', '0', '--to', '4']);
  assert.equal(existsSync(seen[0][seen[0].indexOf('--out') + 1]), false, 'the export file is removed once read');
  const v = await tools.verifySessions({ federationId: toHex(FED), config: '07', firstSession: 0, sessions: ['ee00'] });
  assert.equal(v.federationMatches, true);
  assert.equal(await tools.theftEvidenceOf(toHex(FED), { ...ALARM, kind: 'unbacked-spend', txid: 'ab'.repeat(32) }), null, 'an unbacked spend waits for the spend watch');

  const old = theftTools({ bin: '/bin/tool', dirOf: () => dir, spawn: fakeSpawn(() => null) });
  assert.equal(await old.verifySessions({ sessions: [] }), undefined, 'a tool with no theft-verify mode gives no word');
  assert.equal(await old.theftEvidenceOf(toHex(FED), ALARM), null);
  assert.equal(await theftTools({ bin: null }).verifySessions({}), undefined);
  (await import('node:fs')).rmSync(dir, { recursive: true, force: true });
});
