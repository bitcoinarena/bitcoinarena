// kanban #3034: the card's test
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit nostr r3 #2: the relay's standing (kanban #2847) is meant for "a key that signed an identity proof for a COUNTED round ...
// its amount settled" (nostr-relay.js, tools/nostr-relay.mjs). readStanding (tools/nostr-relay.mjs) takes every entry of the host seat's
// GET /season-rounds whose payoutMsat is not null - and a FREE round's FINAL entry is served with payoutMsat '0' at once (season-read.js:
// `if (!paid) return { ...base, payoutMsat: 0n }`), no stake, no settlement, a round the network season does not count (season-stands.js:
// "a free round ... does not count for the season"). So a stranger's free-round entries under fresh identities (each with its own
// consented lobby record) give each identity standing on the game's relay: never evicted, no proof of work - the #2987 lock-out without
// even the 7-day wait.
// SAFE: an identity whose only round is a free one (0 staked, nothing settled) gets no relay standing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';
import { startRelay } from '../src/nostr-relay.js';
import { runId } from '../src/verdict.js';
import { contractFor, b32, opts } from './window-fixture.js';
import { encodeRoundContract, encodeEntryContract, roundId, entryId } from '../../arena-protocol/src/contracts.js';
import { encodePlayerResult, joinSignedResult, resultId } from '../../arena-protocol/src/result.js';
import { encodeLobbyName } from '../../arena-protocol/src/lobby-name.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK_GAME_ID } from './plugins/hosted.js';
import { HOSTED } from './plugins/hosted.js';
import { key, ev, open, ask, publish } from './_r22-common.mjs';

// the host relay tool's own readStanding, taken from its source (importing the tool would start a relay on its port)
const src = readFileSync(new URL('../tools/nostr-relay.mjs', import.meta.url), 'utf8');
const fn = src.slice(src.indexOf('export async function readStanding'), src.indexOf('\nconst refresh'));
const readStanding = new Function(`return (${fn.replace('export ', '')});`)();

const SECRETS = [b32(0x31), b32(0x32)];
const SEATS = SECRETS.map((s) => schnorr.getPublicKey(s));

// one FREE round as the seat holds it once played: the stranger's entry under a fresh round key, its run FINAL at both committee seats,
// its lobby record naming the stranger's fresh identity with that identity's consent (POST /name checks it; written as the door writes it)
function freeRound(round, n, identity, startMs) {
  const db = round.db;
  const contract = { ...contractFor(SEATS, 3000n, ['wss://r.example']), gameId: NEXTBLOCK_GAME_ID, stakeMsat: 0n, startTimeMs: BigInt(startMs), censusHeight: 910000 + n };
  const rid = roundId(contract);
  db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(rid, encodeRoundContract(contract), 1);
  round.recordSignerNodes(rid, SEATS);
  const p = b32(0x50 + n);
  const e = { roundId: rid, playerPubkey: p, sessionPubkey: b32(0x60), stakeCommitment: b32(0x70), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick: 0,
    worldSecret: b32(0), vssSharesRef: b32(0x80), stakePoint: Uint8Array.from([2, ...b32(0x90)]), feePreimage: b32(0), stakeLockOutpoint: { txid: b32(0xa0), outIdx: 0n },
    feeLockOutpoint: { txid: b32(0), outIdx: 0n }, claimKeyAttestationRef: b32(0) };
  const eid = entryId(e);
  db.prepare('INSERT INTO entries (entry_id, round_id, contract, joined_ms) VALUES (?, ?, ?, ?)').run(eid, rid, encodeEntryContract(e), 1);
  let run = null;
  for (let s = 0; s < 2; s++) {
    const r = { roundId: rid, playerPubkey: p, outcome: 'FAILED', score: 1, transcriptHash: b32(0xb0), simCoreHash: contract.simCoreHash, nodePubkey: SEATS[s] };
    run = runId(r);
    db.prepare('INSERT INTO results (round_id, entry_id, node_pubkey, result_id, bytes, seen_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(rid, eid, SEATS[s], resultId(r), joinSignedResult(encodePlayerResult(r), schnorr.sign(resultId(r), SECRETS[s])), 2);
  }
  for (let s = 0; s < 2; s++) db.prepare('INSERT INTO final_sigs (round_id, entry_id, run_id, signer_pubkey, bytes, seen_ms) VALUES (?, ?, ?, ?, ?, ?)')
    .run(rid, eid, run, SEATS[s], new Uint8Array(1), 3);
  round.putLobbyName({ roundId: rid, playerPubkey: p, signature: new Uint8Array(64), identitySig: new Uint8Array(64), atMs: 5,
    record: encodeLobbyName({ roundId: rid, playerPubkey: p, identityPubkey: identity, name: 'x', atMs: 5 }) });
}

test('audit nostr r3 #2: an identity whose only round is a free one (nothing staked, nothing settled) gets no relay standing', async () => {
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts });
  const base = `http://127.0.0.1:${d.port}`;
  const socks = [];
  let r = null;
  try {
    // the stranger: three fresh Nostr keys, one free round each
    const strangers = [key(), key(), key()];
    strangers.forEach((k, i) => freeRound(d.round, i + 1, Uint8Array.from(Buffer.from(k.pub, 'hex')), Date.now() - 3600000 + i));
    const page = await (await fetch(`${base}/season-rounds?game=nextblock&days=90&page=1`)).json();
    console.log('  served:', JSON.stringify(page.rounds.map((x) => x.entries.map((e) => [e.player.slice(0, 8), e.stakeMsat, e.payoutMsat, e.outcome]))));
    const standing = await readStanding([base], ['nextblock'], fetch);
    const got = strangers.filter((k) => standing.has(k.pub)).length;

    // what that standing does on the game's relay (a small total): the stranger's keys fill the state pool, and a newcomer's first profile
    // is refused 'blocked: the relay is full' - nothing of the stranger's can be evicted (with pow at its real cap the newcomer is first asked 28 bits)
    r = await startRelay({ port: 0, pow: true, standing: () => standing, limits: { totalEvents: 30, powFill: 0.5, powMax: 0 } });   // powMax 0: the newcomer is asked no work, so only room decides
    const t0 = Math.floor(Date.now() / 1000) - 1000;
    const fill = strangers.flatMap((k, i) => Array.from({ length: 10 }, (_, j) => ev(k, { kind: 30762, at: t0 + i * 10 + j, tags: [['d', `x${j}`]], content: '{}' })));
    const filled = await publish(r.port, fill, socks);
    const ws = await open(r.port); socks.push(ws);
    const newcomer = ev(key(), { kind: 0, content: '{"name":"new player"}' });
    const [ok] = await ask(ws, ['EVENT', newcomer], (m) => m[0] === 'OK');
    console.log(`  standing granted to ${got} of 3 free-round identities; their ${filled.filter((m) => m[2]).length} fill events kept; newcomer profile: ${ok[2]} ${ok[3]}`);

    assert.equal(got, 0, `readStanding gave relay standing to ${got} identities whose only rounds were free (0 staked, payoutMsat '0', no settlement)`);
  } finally { for (const w of socks) w.terminate(); if (r) await r.close(); await d.close(); }
});

