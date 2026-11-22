// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm1 census-1 (state machine, order: a config activation vs the daily duty): the ballot's state moves - a proposal
// PASSES and its config is live from its activation height (ballot-tally.js spans, the serving rule configServesRound behind
// offerRefusal: listing, entry, lock refused at every seat for a round created at or after the activation that names the config
// it replaced). The duty poster's day template never moves with it: dayTemplate (duty-poster.js) copies `configHash` from the
// newest held template of the app (CARRIED), and for Next Block nothing else sets it (duty-guard.js dutyFieldsOf gives only gameId
// and simCoreHash). So the first day posted after the activation names the old config at a census height above the activation -
// refused by every seat - and every later day copies the same old config again: the app's days are unplayable for good, with
// nobody's fault. Safe behaviour: a day the duty posts after an activation names the config live at its census height.
// Fix (kanban #3218): the poster's openGrid names the day's config by dutyDayConfig over the seat's ballot (server.js ballotForDuty).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { createProposals } from '../src/proposals.js';
import { dayTemplate, dutyDayConfig } from '../src/duty-poster.js';
import { encodeConfigProposalBody, proposalBodyId, proposalId, encodeVote, voteMessage, CLASS, CHOICE } from '../../arena-protocol/src/ballot.js';
import { BALLOT_GENESIS, configServesRound } from '../../arena-protocol/src/ballot-chain.js';
import { NETWORK_ID_TESTNET4 } from '../../arena-protocol/src/genesis-ids.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const key = (b) => { const secret = new Uint8Array(32).fill(b); return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const A = key(0x31), B = key(0x32), C = key(0x33);
const CENSUS = [{ pubkey: A.pubkey, outpoint: 'aa:0', bondSats: 50000000n }, { pubkey: B.pubkey, outpoint: 'bb:0', bondSats: 30000000n },
  { pubkey: C.pubkey, outpoint: 'cc:0', bondSats: 20000000n }];
const NET = toHex(NETWORK_ID_TESTNET4);
const NEW = new Uint8Array(32).fill(0x22);
const GID = 'c4'.repeat(32);
const vote = (who, idBytes, choice, height, txid) => ({ payload: encodeVote({ proposalId: idBytes, choice, signature: schnorr.sign(voteMessage(idBytes, choice), who.secret) }), height, txid });

test('wf1489 sm1 census-1: the first duty day after a config activation names the replaced config and every seat refuses it', async () => {
  // a DESIGN proposal 2170f250 (the genesis, Next Block's v4) -> NEW, published 100: review 1, voting 101-106, activation 108
  const publishedAt = 100, activationHeight = 108;
  const body = { networkId: NETWORK_ID_TESTNET4, parent: BALLOT_GENESIS.configHash, configHash: NEW, config: Uint8Array.of(2), class: CLASS.DESIGN, activationHeight,
    proposer: A.pubkey, depositTxid: new Uint8Array(32).fill(0x77) };
  const signature = schnorr.sign(proposalBodyId(body), A.secret);
  const idBytes = proposalId({ ...body, signature });
  const hash = (h) => h.toString(16).padStart(64, '0');
  const record = { id: toHex(idBytes), proposal: toHex(Uint8Array.from([...encodeConfigProposalBody(body), ...signature])), networkId: NET, parent: toHex(body.parent),
    configHash: toHex(NEW), class: 'DESIGN', proposer: toHex(A.pubkey), publishedAt, depositSats: '1000', votingFrom: 101, votingUntil: 107, activationHeight,
    repeal: false, blockHash: hash(publishedAt), state: 'COUNTING' };
  const rows = new Map([[record.id, JSON.stringify(record)]]);
  const store = { read: () => [...rows.values()].map((j) => JSON.parse(j)), write: (list) => { for (const x of list) rows.set(x.id, JSON.stringify(x)); } };
  const proposals = createProposals({ confirmedTx: async () => null, recipientsFor: () => null, lowestBondMinSatsFor: () => 100000n, verify, store });
  let tip = 0;
  const votes = new Map([[101, [vote(A, idBytes, CHOICE.YES, 101, 'a1')]], [102, [vote(B, idBytes, CHOICE.YES, 102, 'b1')]]]);
  const t = createBallotTally({ proposals, tipHeight: async () => tip, votesAt: async (h) => votes.get(h) || [], censusAt: async () => CENSUS,
    blockHashAt: async (h) => (h <= tip ? hash(h) : null), verify, decideDepthFor: () => 1, minDecideDepthFor: () => 1 });
  for (tip = 100; tip <= 120; tip++) await t.pass();
  const p = proposals.list()[0];
  console.log('  outcome:', JSON.stringify(p.decided));
  assert.equal(p.state, 'PASSED', 'the proposal passed (A and B, 80 % of the census, voted YES)');
  assert.equal(t.live(NET).configHash, toHex(NEW), 'the new config is live at the tip');

  // THE DUTY'S NEXT DAY: the newest held Next Block day template names the config every round named until the activation
  const held = [{ seriesGrid: true, networkId: NETWORK_ID_TESTNET4, gameId: new Uint8Array(Buffer.from(GID, 'hex')), startTimeMs: 5n, stakeMsat: 100000n,
    protocolVersion: 29, configHash: BALLOT_GENESIS.configHash, simCoreHash: new Uint8Array(32).fill(9), censusHeight: 90, creatorPubkey: A.pubkey, censusRoot: new Uint8Array(32) }];
  const day = dayTemplate({ held, family: new Set([GID]), networkId: NETWORK_ID_TESTNET4, game: 'nextblock', relays: [] });
  const censusHeight = 118;                                       // the day's anchor census, ten blocks after the activation
  // the seat's ballot as server.js ballotForDuty hands it to the poster, and the config openGrid names the day by (kanban #3218)
  const ballotAt = (h) => ({ history: t.spans(NET), siblings: null, pending: t.live(NET) === null || t.historyAt(NET, h) === null });
  const named = dutyDayConfig({ configHash: day.contract.configHash, height: censusHeight, ballot: ballotAt(censusHeight) });
  assert.ok(named.ok, named.why);
  day.contract.configHash = named.configHash;
  // a day created before the activation keeps the config it was created under
  assert.equal(toHex(dutyDayConfig({ configHash: BALLOT_GENESIS.configHash, height: 105, ballot: ballotAt(105) }).configHash), toHex(BALLOT_GENESIS.configHash));
  const served = configServesRound({ configHash: day.contract.configHash, height: censusHeight, history: t.spans(NET) });
  console.log('  sm1 census-1:', JSON.stringify({ live: t.live(NET).configHash.slice(0, 16), dayNames: toHex(day.contract.configHash).slice(0, 16),
    censusHeight, served: served.ok, why: served.why ? served.why.slice(0, 160) : null }));
  assert.equal(toHex(day.contract.configHash), toHex(NEW), 'the day posted after the activation names the config live at its census height');
  assert.ok(served.ok, 'and every seat serves it (configServesRound / offerRefusal)');
});

test('wf1489 sm1 census-1 (kanban #3218): while the ballot has a proposal activating by the census height undecided, no day is posted', () => {
  const got = dutyDayConfig({ configHash: BALLOT_GENESIS.configHash, height: 118, ballot: { history: [], siblings: null, pending: true } });
  assert.equal(got.ok, false);
  assert.match(got.why, /not known yet/);
  // a seat that counts no ballot names the template's config as before
  assert.equal(toHex(dutyDayConfig({ configHash: BALLOT_GENESIS.configHash, height: 118, ballot: null }).configHash), toHex(BALLOT_GENESIS.configHash));
});
