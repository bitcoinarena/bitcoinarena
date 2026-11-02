// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SIGNER'S TWO RESULTS ABOUT ONE RUN, FILED BY THE SEAT AND JUDGED BY THE ARBITER (spec §5A.3 row 1, kanban #986). The seven signer nodes of
// slash-filing.test.js, with one stub peer answering GET /results: a signer's second result reaches the holder the way every peer's record
// does, through the close's gather. Until this `results` kept the first and the second stopped at INSERT OR IGNORE.
//
// WHAT MUST NOT SLASH is half of this file. One player key holds several entries of a round, each with its own honest result, and a peer can
// hand any of them under any entry; a transcript's bytes name its entry, so only two results about ONE transcript are the offence.
// MEASURED BEFORE (4e012f311): a second result was dropped, no proof, no door, and slashHoldsOnDoubleSign slashed two entries of one key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sevenSignerNodes, wait, b32, rand, WINDOW_MS } from './window-fixture.js';
import { testNow } from './test-clock.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { arbitrationCommitmentIn } from '../../arena-protocol/src/arbitration-tx.js';
import { deriveCensus } from '../../arena-protocol/src/census.js';
import { bondSetFor } from '../src/curve.js';
import { decodePlayerResult, splitSignedResult, encodePlayerResult, joinSignedResult, resultId } from '../../arena-protocol/src/result.js';
import { encodeSlashProof, orderedResultIds, joinDoubleSlashEvidence, splitDoubleSlashEvidence, cutDoubleSlashEvidence, slashProofId, TWO_RESULTS } from '../../arena-protocol/src/slash.js';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { bondOutputKey, bondInternalKey } from '../../arena-protocol/src/bond-script.js';
import { arbitrationMembers, judgeDoubleProof, buildSlash, memberSign, assemble } from '../src/arbiter.js';
import { entriesForSlash } from '../src/slash-owing.js';
import { tweakPoint, combine } from '../src/curve.js';
import { eventStands } from '../src/arbitration-events.js';
import { stubBitcoind } from './stub-bitcoind.js';

const set = arbitrationMembers('regtest');
const signed = (r, secret) => joinSignedResult(encodePlayerResult(r), schnorr.sign(resultId(r), secret));

/** The fixture with a stub peer whose GET /results answers what `say` holds, and each signer's held result by name. */
async function withPeer(run) {
  const peer = { body: new Uint8Array(0), events: [] };
  const stub = createServer((req, res) => {
    if (req.url.startsWith('/results')) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(Buffer.from(peer.body)); }
    if (req.method === 'POST' && req.url === '/liquidations/events') {
      let body = ''; req.on('data', (d) => { body += d; });
      return req.on('end', () => { peer.events.push(JSON.parse(body)); res.writeHead(201); res.end('kept'); });
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${stub.address().port}`;
  const w = await sevenSignerNodes(WINDOW_MS, undefined, { endMs: testNow() + 4000, storedBeforeTheRule: true, peers: [url],
    finality: { everyMs: 100, rerunMs: 30000, doubleFileMs: 100 } });
  try {
    w.sign('agrees', () => ({}));
    const eid = w.runs.agrees.eid;
    const held = (secret) => decodePlayerResult(splitSignedResult(w.holder.round.heldResult(w.rid, eid, schnorr.getPublicKey(secret)).bytes).body);
    const say = async (...records) => { peer.body = new Uint8Array(records.flatMap((r) => [...r])); await w.holder.verifier.gather(w.rid, eid); };
    await run({ w, eid, held, say, base: `http://127.0.0.1:${w.holder.port}`, peer: { ...peer, url } });
  } finally { await w.close(); await new Promise((r) => stub.close(r)); }
}

test('a second result about one run is noticed in the gather, filed as TWO_RESULTS, listed, served, relayed and owed, and the arbiter slashes on the two signatures alone', { timeout: 170000 }, async () => {
  await withPeer(async ({ w, eid, held, say, base }) => {
    const accused = w.others[0];
    const first = held(accused);
    const second = { ...first, score: first.score + 7 };
    const secondBytes = signed(second, accused);
    await say(secondBytes);

    // WHAT THE SEAT FILED
    const filed = w.holder.round.doubleSlashProofs(w.rid);
    assert.equal(filed.length, 1, 'a second result about one run is filed');
    const got = splitDoubleSlashEvidence(filed[0].bytes);
    const { named, other } = orderedResultIds(resultId(first), resultId(second));
    const advert = w.adverts.get(toHex(first.nodePubkey));
    const id = toHex(slashProofId(got.proof));
    assert.equal(toHex(got.proof.nodePubkey), toHex(first.nodePubkey));
    assert.equal(toHex(got.proof.signedResultId), toHex(named));
    assert.equal(toHex(got.proof.transcriptHash), toHex(other));
    assert.equal(toHex(got.proof.bondTxid), toHex(advert.bondTxid));
    assert.equal(got.proof.bondVout, advert.bondVout);
    assert.equal(toHex(filed[0].entryId), toHex(eid));
    assert.equal(toHex(w.holder.round.heldResult(w.rid, eid, first.nodePubkey).resultId), toHex(resultId(first)), 'the first stays the one kept');

    // AND EVERY DOOR THE REPLAY'S AND THE AUDIT'S PROOFS HAVE
    const list = await (await fetch(`${base}/slashes`)).json();
    assert.deepEqual(list.doubleSlashes.map((s) => [s.round, s.entry, s.node, s.proof]), [[toHex(w.rid), toHex(eid), toHex(first.nodePubkey), id]]);
    assert.equal(list.slashes.length, 0, 'the old list is unchanged');
    const served = new Uint8Array(await (await fetch(`${base}/double-slash-proofs?round=${toHex(w.rid)}`)).arrayBuffer());
    assert.equal(toHex(cutDoubleSlashEvidence(served)[0]), toHex(filed[0].bytes));
    const relayed = new Uint8Array(await (await fetch(`${base}/slash/${id}`)).arrayBuffer());
    assert.equal(toHex(relayed), toHex(filed[0].bytes), 'the round\'s relay keeps it under its id');
    assert.equal((await fetch(`${base}/double-slash-proofs?round=zz`)).status, 400);

    const contract = decodeRoundContract(new Uint8Array(w.holder.round.get(w.rid).contract));
    // THIS FIXTURE'S CHAIN STOPS SHORT OF THE ROUND'S CENSUS HEIGHT (slash-filing.test.js says so), so the door's census read is the one thing handed in
    w.holder.roster.censusAtHeight = () => ({ ok: true, tipHeight: contract.censusHeight + 5, entries: [{ pubkey: first.nodePubkey, bondSats: 2_000_000n }] });
    const owed = await (await fetch(`${base}/slash-owing?round=${toHex(w.rid)}&entry=${toHex(eid)}&height=${contract.censusHeight}`)).json();
    assert.equal(owed.owing.length, 1, JSON.stringify(owed));
    assert.equal(owed.owing[0].offence, TWO_RESULTS, JSON.stringify(owed));
    assert.equal(owed.owing[0].node, toHex(first.nodePubkey));
    assert.equal(owed.owing[0].playersMsat, '0', 'a doubled result with no replay shows no loss (§5A.3)');
    assert.deepEqual(owed.owing[0].players, []);
    assert.equal(BigInt(owed.owing[0].reservesMsat), BigInt(owed.owing[0].bondSats) * 1000n, 'so the whole bond goes to the reserves');

    // FILED ONCE: the same pair again, and a third result, file nothing new
    await say(secondBytes);
    await say(signed({ ...first, score: first.score + 8 }, accused));
    assert.equal(w.holder.round.doubleSlashProofs(w.rid).length, 1);

    // THE ARBITER'S OWN JUDGEMENT, FROM WHAT THE DOOR SERVED
    const committee = w.holder.round.signerNodes(w.rid);
    const bondOutpoint = { txid: advert.bondTxid, vout: advert.bondVout };
    const judged = (over = {}) => judgeDoubleProof({ evidence: filed[0].bytes, roundIdBytes: w.rid, committee, advert, bondOutpoint, ...over });
    const verdict = judged();
    assert.equal(verdict.slashed, true, verdict.why);
    assert.equal(verdict.offence, TWO_RESULTS);
    assert.equal(toHex(verdict.proofId), id);

    // REFUSED: another round, a committee without the accused, a bond its advertisement does not name, no advertisement, rubbish, a pair by the wrong signer
    assert.match(judged({ roundIdBytes: b32(0xee) }).why, /another round/);
    assert.match(judged({ committee: committee.filter((k) => toHex(k) !== toHex(first.nodePubkey)) }).why, /not on this round's committee/);
    assert.match(judged({ bondOutpoint: { txid: b32(0xcd), vout: 9 } }).why, /the proof names bond/);
    assert.match(judged({ advert: null }).why, /no advertisement/);
    assert.match(judged({ evidence: filed[0].bytes.subarray(0, 300) }).why, /not a proof of two results/);
    const flipped = filed[0].bytes.slice(); flipped[flipped.length - 1] ^= 1;
    assert.match(judged({ evidence: flipped }).why, /is not the accused node's/);

    // PATH B: one escrow, nobody's loss, the rest to the reserves
    const internalKey = bondInternalKey({ nodeKey: first.nodePubkey, arbitrationKeys: set.keys }, { combine }).internalKey;
    const k = bondOutputKey({ nodeKey: first.nodePubkey, arbitrationKeys: set.keys, arbitrationK: set.k, bondMaturity: 100, internalKey }, { tweakPoint, combine });
    const bond = { txid: advert.bondTxid, vout: advert.bondVout, value: 2_000_000n, script: Uint8Array.from([0x51, 0x20, ...k.outputKey]) };
    const slash = buildSlash({ verdict, bond, advert: { ...advert, bondScriptTemplateVersion: 1 }, contract, roundId: w.rid, slashHeight: contract.censusHeight + 10, tipHeight: contract.censusHeight + 12, set,
      entries: entriesForSlash(w.holder.round, w.rid).map((e) => ({ ...e, stakeMsat: 1_000_000n, activated: true, outcome: 'FAILED', score: 0, finalProven: true })) });
    assert.equal(slash.ok, true, slash.why);
    assert.deepEqual(slash.built.tx.outputs.slice(1).map((o) => o.pays), ['the slash\'s escrow']);
    assert.equal(slash.distribution.players.size, 0);
    assert.equal(slash.distribution.playersMsat, 0n);
    const five = assemble({ slash, signatures: set.members.slice(0, 5).map((m) => ({ key: m.key, sig: memberSign(m, slash.sighash) })), set });
    assert.equal(five.ok, true, five.why);
  });
});

test('what must slash nobody: two entries of one key, a repeat, a stranger, a forged result, and a filing made up from two honest results', { timeout: 170000 }, async () => {
  await withPeer(async ({ w, eid, held, say, base }) => {
    const [a, b, c] = w.others;
    const nothing = async (why) => {
      assert.equal(w.holder.round.doubleResults(w.rid, eid).length, 0, why);
      assert.equal((await (await fetch(`${base}/slashes`)).json()).doubleSlashes.length, 0, why);
    };

    // THE SAME PLAYER'S OTHER ENTRY, ITS OWN TRANSCRIPT AND ITS OWN SCORE, HANDED UNDER THIS ENTRY BY A PEER
    const honest = held(a);
    const otherEntry = { ...honest, transcriptHash: b32(0x71), score: honest.score + 900 };
    await say(signed(otherEntry, a));
    await nothing('two entries of one key were taken for a double signing');

    // A REPEAT OF WHAT IS HELD
    await say(signed(held(b), b));
    await nothing('a retransmission was taken for a double signing');

    // A STRANGER'S TWO ANSWERS: signed, about this run, and no seat of the round
    const stranger = rand(32);
    const theirs = { ...held(c), nodePubkey: schnorr.getPublicKey(stranger) };
    await say(signed(theirs, stranger), signed({ ...theirs, score: theirs.score + 1 }, stranger));
    await nothing('a stranger was accused');

    // A SECOND RESULT NAMING A SIGNER, SIGNED BY ANOTHER KEY: refused at the signature, so its row is never compared
    await say(joinSignedResult(encodePlayerResult({ ...held(c), score: 9 }), schnorr.sign(resultId({ ...held(c), score: 9 }), stranger)));
    await nothing('a forged result was kept');

    // A FALSE FILING, BY HAND, ANYONE COULD POST: the accused's two real results of two entries, the proof perfectly formed. The relay's door
    // takes bytes that are what they say; the judgement is where it dies.
    const pairOf = (x, y, secret) => {
      const { named, other } = orderedResultIds(resultId(x), resultId(y));
      const proof = { roundId: w.rid, playerPubkey: x.playerPubkey, nodePubkey: x.nodePubkey, transcriptHash: other, signedResultId: named,
        bondTxid: w.adverts.get(toHex(x.nodePubkey)).bondTxid, bondVout: w.adverts.get(toHex(x.nodePubkey)).bondVout };
      const first = toHex(resultId(x)) === toHex(named) ? x : y, second = first === x ? y : x;
      return joinDoubleSlashEvidence(encodeSlashProof(proof), signed(first, secret), signed(second, secret));
    };
    const judge = (evidence, key) => judgeDoubleProof({ evidence, roundIdBytes: w.rid, committee: w.holder.round.signerNodes(w.rid), advert: w.adverts.get(key),
      bondOutpoint: { txid: w.adverts.get(key).bondTxid, vout: w.adverts.get(key).bondVout } });
    const key = toHex(honest.nodePubkey);
    const twoEntries = judge(pairOf(honest, otherEntry, a), key);
    assert.equal(twoEntries.slashed, false);
    assert.match(twoEntries.why, /two entries of one player/);

    // THE SAME BYTES WITH RESULTS NOBODY SIGNED: the accused's real pair of one run, signed by a stranger's key in its name
    const invented = pairOf(honest, { ...honest, score: honest.score + 1 }, stranger);
    assert.match(judge(invented, key).why, /is not the accused node's/);

    // AND THE RELAY KEEPS ONLY THE PAIR THE PROOF NAMES
    const proofId = toHex(slashProofId(splitDoubleSlashEvidence(invented).proof));
    assert.equal((await fetch(`${base}/slash/${'00'.repeat(32)}`, { method: 'PUT', body: invented })).status, 409);
    const swapped = invented.slice();
    const { signedResults } = splitDoubleSlashEvidence(invented);
    swapped.set(signedResults[1], 199); swapped.set(signedResults[0], 199 + signedResults[1].length);
    assert.equal((await fetch(`${base}/slash/${proofId}`, { method: 'PUT', body: swapped })).status, 409);
  });
});

test('a pair kept before the signer\'s advertisement is, is filed once it is, by the seat\'s pass', { timeout: 170000 }, async () => {
  await withPeer(async ({ w, eid, held, say }) => {
    const accused = w.others[1];
    const first = held(accused), key = toHex(first.nodePubkey);
    const advert = w.adverts.get(key);
    w.adverts.delete(key);
    await say(signed({ ...first, outcome: 'DELIVERED' }, accused));
    await wait(300);
    assert.equal(w.holder.round.doubleResults(w.rid, eid).length, 1, 'the pair is kept whatever else is missing');
    assert.equal(w.holder.round.doubleSlashProofs(w.rid).length, 0, 'and accused on no guessed bond');

    w.adverts.set(key, advert);
    const stop = Date.now() + 5000;
    while (Date.now() < stop && !w.holder.round.doubleSlashProofs(w.rid).length) await wait(50);
    assert.equal(w.holder.round.doubleSlashProofs(w.rid).length, 1, 'filed by the pass');
    assert.equal(toHex(splitDoubleSlashEvidence(w.holder.round.doubleSlashProofs(w.rid)[0].bytes).proof.bondTxid), toHex(advert.bondTxid));
  });
});

test('the arbitration service, run whole: a true pair is judged, posted and published as TWO_RESULTS; a false filing the seat lists is refused, and nothing is posted for it', { timeout: 170000 }, async () => {
  await withPeer(async ({ w, eid, held, say, base, peer }) => {
    const contract = decodeRoundContract(new Uint8Array(w.holder.round.get(w.rid).contract));
    const view = w.slot.chainWith(contract);
    // THE BONDS AS THE CHAIN NAMES THEM: the service reads the accused's off its own census
    const byTxid = new Map();
    for (const b of view.blocks) for (const raw of b.transactions) byTxid.set(toHex(parseTransaction(raw).txid), raw);
    const census = deriveCensus(view, { contract, bond: bondSetFor('regtest'), resolve: (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; } });
    assert.equal(census.ok, true, census.why);
    for (const e of census.entries) w.adverts.set(toHex(e.pubkey), { nodePubkey: e.pubkey, bondTxid: e.txid, bondVout: e.vout });

    const [guilty, honest] = w.others;
    const first = held(guilty);
    await say(signed({ ...first, score: first.score + 7 }, guilty));
    const trueProof = toHex(w.holder.round.doubleSlashProofs(w.rid)[0].proofId);

    // A LYING SEAT'S LISTING: an honest signer's two results of two entries of one key, written straight into the store as a filing
    const clean = held(honest), secondEntry = { ...clean, transcriptHash: b32(0x71), score: clean.score + 3 };
    const advert = w.adverts.get(toHex(clean.nodePubkey));
    const { named, other } = orderedResultIds(resultId(clean), resultId(secondEntry));
    const proof = { roundId: w.rid, playerPubkey: clean.playerPubkey, nodePubkey: clean.nodePubkey, transcriptHash: other, signedResultId: named, bondTxid: advert.bondTxid, bondVout: advert.bondVout };
    const lower = toHex(resultId(clean)) === toHex(named) ? clean : secondEntry, higher = lower === clean ? secondEntry : clean;
    w.holder.round.putDoubleResult(w.rid, eid, clean.nodePubkey, signed(clean, honest), signed(secondEntry, honest));
    assert.equal(w.holder.round.fileDoubleResult(w.rid, eid, clean.nodePubkey, slashProofId(proof), joinDoubleSlashEvidence(encodeSlashProof(proof), signed(lower, honest), signed(higher, honest))), 1);
    const falseProof = toHex(slashProofId(proof));

    const chain = await stubBitcoind(view, view.firstHeight + 20, Math.floor(Number(contract.committeeTimeMs) / 1000));
    const dir = mkdtempSync(join(tmpdir(), 'arbiter-986-'));
    try {
      writeFileSync(join(dir, 'cookie'), 'u:p');
      const state = join(dir, 'state.json');
      const ran = await new Promise((done) => execFile(process.execPath, [new URL('../tools/arbiter.mjs', import.meta.url).pathname, '--once'],
        { timeout: 90000, env: { ...process.env, ARENA_ARBITER_NETWORK: 'regtest', ARENA_ARBITER_SEATS: base, ARENA_BITCOIND_URL: chain.url, ARENA_BITCOIND_COOKIE: join(dir, 'cookie'),
          ARENA_ARBITER_PORT: '0', ARENA_ARBITER_STATE: state, ARENA_ARBITER_LOOKBACK: '20', ARENA_ARBITER_PUBLISH: peer.url, ARENA_APPS: new URL('../../nextblock/plugin/nextblock.js', import.meta.url).href } },
        (err, out, errOut) => done({ err, out: String(out), errOut: String(errOut) })));
      assert.equal(ran.err, null, `${ran.out}\n${ran.errOut}`);
      assert.ok(existsSync(state), `the service kept nothing:\n${ran.out}\n${ran.errOut}`);
      const handled = JSON.parse(readFileSync(state, 'utf8')).handled;

      assert.ok(handled[trueProof], ran.out);
      assert.equal(handled[trueProof].offence, 'TWO_RESULTS', ran.out);
      assert.equal(handled[trueProof].posted, 'cd'.repeat(32), ran.out);
      assert.deepEqual(handled[trueProof].players, [], 'a doubled result with no replay pays no player');
      assert.equal(handled[trueProof].node, toHex(first.nodePubkey));

      assert.ok(handled[falseProof], ran.out);
      assert.equal(handled[falseProof].posted, undefined, 'a bond was taken on a false filing');
      assert.equal(handled[falseProof].offence, undefined, 'and no offence is said for it');
      assert.match(handled[falseProof].why, /two entries of one player/);

      // ONE TRANSACTION, COMMITTING TO THE TRUE PROOF AND SPENDING THE GUILTY BOND
      assert.equal(chain.sent.length, 1, ran.out);
      const tx = parseTransaction(fromHex(chain.sent[0]));
      const guiltyBond = w.adverts.get(toHex(first.nodePubkey));
      assert.equal(toHex(tx.inputs[0].previousTxid), toHex(guiltyBond.bondTxid));
      assert.equal(tx.inputs[0].previousVout, guiltyBond.bondVout);
      assert.equal(toHex(arbitrationCommitmentIn(tx.outputs).proofId), trueProof, 'OP_RETURN = H(fraud_proof) ...');

      // AND THE PUBLISHED EVENT NAMES THE OFFENCE THE JUDGEMENT FOUND
      const said = peer.events.map((e) => e.event);
      assert.deepEqual(said.map((e) => [e.kind, e.proof, e.offence]), [['slash', trueProof, 'TWO_RESULTS']], ran.out);
      assert.ok(eventStands(peer.events[0], { keys: set.keys, k: set.k, verify: (s, m, k) => schnorr.verify(s, m, k) }).ok, 'signed by k of the set');
    } finally { await chain.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
