// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A ROUND OF AN EVENT-MARKET TEMPLATE AT A SEAT (feature 5): the seat opens a round of a template only when it
// asks its own question, and a round of any other game only when it asks none (POST /round, 409 by name); it lists the
// round with its question (GET /rounds), names it beside the contract's bytes (GET /round) and in its outcome (GET /outcome),
// and takes an attestation only as an index into THE ROUND'S outcomes and only from the round's own resolution time
// (POST /outcome). Harness: round-creator-door's (one seat, the bonded chain, a free round).
import { lockPort, bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { contractFor, opts, b32, presentDay } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { encodeAttestation } from '../../arena-protocol/src/attested.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { testAttestedGame, attestorSign } from './plugins/sign.js';
import { MARKET } from './plugins/market/index.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';

const TEMPLATE = testAttestedGame({ name: 'event-anything', outcomes: ['yes', 'no'], attestors: ['event a', 'event b', 'event c'], threshold: 2,
  marketTerms: { nodeFeeBps: 50, donationBps: 50, question: 'Anything that happens', resolveAfterCloseMs: 60000n, deadlineAfterResolveMs: 3600000n,
    sourceRule: 'two public reports of it, read by each attestor on its own' },
  template: { category: 'world', maxOutcomes: 4, resolveWithinMs: 7n * 24n * 3600000n }, requiredProtocolVersion: 4 });
const EVENT = (entryCloseMs) => ({ question: 'Which team wins the 2026 Arena cup final?', outcomes: ['red', 'blue', 'green', 'nobody'], resolveAtMs: entryCloseMs + 120000n });

test('a seat opens a template\'s round only with its question and any other round only without; lists, serves and attests it by the round\'s own outcomes', async () => {
  const slot = bondedChainSlot(lockPort());
  const plugins = [NEXTBLOCK, MARKET.registration, TEMPLATE.registration];
  const d = await serve(openStore(':memory:'), { plugins, port: 0, stakeLocks: slot.port, ...opts, chainFor: slot.chainFor,
    randomnessFor: slot.randomnessFor, claimKeyFor: () => new Uint8Array(33).fill(2) });
  try {
    const base = `http://127.0.0.1:${d.port}`;
    const post = async (path, body) => { const r = await fetch(`${base}${path}`, { method: 'POST', body }); return { status: r.status, text: (await r.text()).trim() }; };
    // A FREE v4 ROUND OF AN ATTESTED GAME, its end 15 min out: no core, no config, its question (or none)
    const drafted = (gameId, event) => {
      const c = { ...presentDay({ ...contractFor([d.round.pubkey, b32(0x33)], 3000n, ['wss://r.example']), protocolVersion: 4, stakeMsat: 0n,
        gameId, simCoreHash: new Uint8Array(32), configHash: new Uint8Array(32) }, testNow() + 900000) };
      return event ? { ...c, event: event(c.entryCloseMs) } : c;
    };
    const bonded = (c) => ({ ...c, censusRoot: bondedChainFor(c.nodes, c, slot, { endpoints: [`ws://127.0.0.1:${d.port}`], protocolVersions: [1, 2, 3, 4],
      hostedGames: plugins.map((p) => p.gameId) }).censusRoot });

    // REFUSED BY NAME: a template's round with no question; a non-template market's round with one
    const none = await post('/round', encodeRoundContract(bonded(drafted(TEMPLATE.registration.gameId, null))));
    const foreign = await post('/round', encodeRoundContract(bonded(drafted(MARKET.registration.gameId, EVENT))));
    // OPENED: a template's round with its question
    const c = bonded(drafted(TEMPLATE.registration.gameId, EVENT));
    const rid = toHex(roundId(c));
    const opened = await post('/round', encodeRoundContract(c));
    console.log(`  template round without a question: ${none.status} "${none.text}"`);
    console.log(`  btc-close round with a question: ${foreign.status} "${foreign.text}"`);
    console.log(`  template round ${rid.slice(0, 16)} with "${c.event.question}": ${opened.status}`);
    assert.equal(none.status, 409); assert.match(none.text, /template "event-anything" is a market template: each round of it asks its own question, outcomes and resolution time, and this one names none/);
    assert.equal(foreign.status, 409); assert.match(foreign.text, /game "btc-close" is not a market template: its question is its manifest's, and a round of it carries none of its own/);
    assert.equal(opened.status, 201, opened.text);

    // GET /round: the contract's bytes, its question beside them
    const got = await fetch(`${base}/round?id=${rid}`);
    assert.equal(got.status, 200);
    assert.deepEqual(new Uint8Array(await got.arrayBuffer()), encodeRoundContract(c));
    assert.equal(decodeURIComponent(got.headers.get('x-question')), c.event.question);
    assert.deepEqual(JSON.parse(decodeURIComponent(got.headers.get('x-outcomes'))), c.event.outcomes);
    assert.equal(got.headers.get('x-resolve-at-ms'), String(c.event.resolveAtMs));
    // GET /rounds: the row carries the question
    const listing = await (await fetch(`${base}/rounds`)).json();
    const row = listing.rounds.find((r) => r.id === rid);
    assert.ok(row, 'the template round is not listed');
    assert.deepEqual(row.event, { question: c.event.question, outcomes: c.event.outcomes, resolveAtMs: String(c.event.resolveAtMs) });
    assert.equal(row.game.name, 'event-anything');
    // GET /outcome: OPEN, with the round's question and labels - not the template's YES / NO
    const open = await (await fetch(`${base}/outcome?round=${rid}`)).json();
    assert.equal(open.state, 'OPEN'); assert.deepEqual(open.outcomes, c.event.outcomes); assert.equal(open.question, c.event.question);
    console.log(`  GET /round x-question "${decodeURIComponent(got.headers.get('x-question'))}"; /rounds row event ${JSON.stringify(row.event)}; /outcome ${JSON.stringify({ state: open.state, outcomes: open.outcomes })}`);

    // POST /outcome: after the entry close but before the round's own resolution time - refused; then the index out of the
    // round's range (4 of 4) refused, and 3 ("nobody", beyond the template's own two) held
    const [A0, , A2] = TEMPLATE.attestors;
    const attest = (outcome, observedAtMs) => { const body = { roundId: roundId(c), outcome, observedAtMs }; return encodeAttestation({ ...body, signatures: [A0, A2].map((a) => attestorSign(a, body)) }); };
    skipTo(Number(c.entryCloseMs) + 1000);
    const early = await post(`/outcome?round=${rid}`, attest(3, c.entryCloseMs + 1000n));
    skipTo(Number(c.event.resolveAtMs) + 1000);
    const four = await post(`/outcome?round=${rid}`, attest(4, c.event.resolveAtMs + 500n));
    const three = await post(`/outcome?round=${rid}`, attest(3, c.event.resolveAtMs + 500n));
    console.log(`  observed before its resolution time: ${early.status} "${early.text.slice(0, 120)}"`);
    console.log(`  outcome 4: ${four.status} "${four.text}"`);
    console.log(`  outcome 3: ${three.status} ${three.text.slice(0, 160)}`);
    assert.equal(early.status, 409); assert.match(early.text, /before the market's resolution time/);
    assert.equal(four.status, 409); assert.match(four.text, /names outcome 4, out of range: game "event-anything" has 4 outcomes \(0 to 3\)/);
    assert.equal(three.status, 201, three.text);
    const held = await (await fetch(`${base}/outcome?round=${rid}`)).json();
    assert.equal(held.state, 'ATTESTED'); assert.equal(held.outcome, 3); assert.equal(held.label, 'nobody');
  } finally { await d.close(); }
});
