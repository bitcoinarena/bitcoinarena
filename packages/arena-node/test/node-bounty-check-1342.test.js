// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1342 (Daniel 2026-11-08): the node bounty's checklist, read from the seats' public doors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { nodeBountyCheck } from '../src/node-bounty-check.js';
import { ownerStatementMessage } from '../src/owner.js';
import { toHex } from '../../arena-protocol/src/hash.js';

// the node's identity: it signs its owner statement (kanban #1418)
const NODE_SECRET = new Uint8Array(32).fill(0x2a), NODE = toHex(schnorr.getPublicKey(NODE_SECRET)), ME = 'bb'.repeat(32), OTHER = 'cc'.repeat(32);
const said = (owner, atMs) => ({ node: NODE, claimed: true, owner, statement: { atMs, sig: toHex(schnorr.sign(ownerStatementMessage({ node: NODE, owner, atMs }), NODE_SECRET)) } });
const DAY = 24 * 3600 * 1000, NOW = 20000 * DAY + 5000;
// two seats; the node served one round a day on `servedDays` of the last 7, signing each, and claims `owner`
const fake = ({ servedDays, owner }) => async (url) => {
  if (url.endsWith('/owner')) return url.startsWith('https://node.example') ? said(owner, NOW - 1000) : { node: 'dd'.repeat(32), claimed: true, owner: OTHER };
  const from = Number(new URL(url).searchParams.get('from')), dayAgo = Math.round((Math.floor(NOW / DAY) * DAY - from) / DAY);
  const held = servedDays.includes(dayAgo) ? [{ roundId: `r${dayAgo}`, committee: [NODE, OTHER], finals: [NODE] }] : [];
  return { held };
};
const seats = ['https://seat1.example', 'https://node.example'];

test('#1342 the node checklist: one day online in the last 7 passes, whoever owns it (Daniel 2026-11-10); never served or a team node does not', async () => {
  const all = await nodeBountyCheck({ node: NODE, npub: ME, seats, fetchJson: fake({ servedDays: [3], owner: ME }), nowMs: NOW });
  const today = await nodeBountyCheck({ node: NODE, seats, fetchJson: fake({ servedDays: [0], owner: ME }), nowMs: NOW });
  const short = await nodeBountyCheck({ node: NODE, npub: ME, seats, fetchJson: fake({ servedDays: [], owner: ME }), nowMs: NOW });
  const theirs = await nodeBountyCheck({ node: NODE, npub: ME, seats, fetchJson: fake({ servedDays: [1, 2, 3, 4, 5, 6, 7], owner: OTHER }), nowMs: NOW });
  const team = await nodeBountyCheck({ node: NODE, npub: ME, seats, fetchJson: fake({ servedDays: [1, 2, 3, 4, 5, 6, 7], owner: ME }), nowMs: NOW, excluded: new Set([NODE]) });
  const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => c.key);
  console.log('  MEASURED #1342 node checklist:', JSON.stringify({ all: [all.passes, all.checks.find((c) => c.key === 'committees').says], short: failed(short), theirs: failed(theirs), team: failed(team) }));
  assert.equal(all.passes, true);
  assert.equal(today.passes, true, 'today counts, and no owner key is needed');
  assert.deepEqual(failed(short), ['census', 'online', 'committees']);
  assert.equal(theirs.passes, true, 'another owner is no condition any more');
  assert.deepEqual([all.owner.ok, theirs.owner.ok, theirs.owner.says], [true, false, 'the node names another owner']);
  assert.deepEqual(failed(team), ['outside']);
  assert.equal((await nodeBountyCheck({ node: 'x', npub: ME, seats, fetchJson: fake({ servedDays: [], owner: ME }) })).ok, false);
  const byHost = await nodeBountyCheck({ node: NODE, npub: ME, seats, fetchJson: fake({ servedDays: [1, 2, 3, 4, 5, 6, 7], owner: ME }), nowMs: NOW, teamHosts: ['node.example'] });
  assert.deepEqual(failed(byHost), ['outside'], 'a node answering at a team host is a team node');
});

// KANBAN #1418 (audit 6, high): any listed seat answered GET /owner for any node and the last answer won - an attacker's seat named itself owner
// of someone else's node and passed the checklist (team-host check included). Now only a statement signed by the node key counts.
test('#1418 a seat naming itself owner of someone else\'s node does not pass: unsigned, forged or stale statements are not the node\'s word', async () => {
  const served = (url) => { const from = Number(new URL(url).searchParams.get('from')), dayAgo = Math.round((Math.floor(NOW / DAY) * DAY - from) / DAY);
    return { held: dayAgo >= 1 && dayAgo <= 7 ? [{ roundId: `r${dayAgo}`, committee: [NODE], finals: [NODE] }] : [] }; };
  const evil = (answer) => async (url) => (url.endsWith('/owner') ? (url.startsWith('https://evil.example') ? (await new Promise((r) => setTimeout(r, 30)), answer) : said(ME, NOW - 5000)) : served(url));
  const seatsE = ['https://node.example', 'https://evil.example'];
  const ATT = 'ee'.repeat(32);
  const forgedSig = toHex(schnorr.sign(ownerStatementMessage({ node: NODE, owner: ATT, atMs: NOW }), new Uint8Array(32).fill(0x33)));
  const cases = {
    unsigned: await nodeBountyCheck({ node: NODE, npub: ATT, seats: seatsE, fetchJson: evil({ node: NODE, claimed: true, owner: ATT }), nowMs: NOW, teamHosts: ['node.example'] }),
    forged: await nodeBountyCheck({ node: NODE, npub: ATT, seats: seatsE, fetchJson: evil({ node: NODE, claimed: true, owner: ATT, statement: { atMs: NOW, sig: forgedSig } }), nowMs: NOW }),
    staleReal: await nodeBountyCheck({ node: NODE, npub: ATT, seats: ['https://evil.example'], fetchJson: async (u) => (u.endsWith('/owner') ? said(ATT, NOW - 3 * DAY) : served(u)), nowMs: NOW }),
    realOwner: await nodeBountyCheck({ node: NODE, npub: ME, seats: seatsE, fetchJson: evil({ node: NODE, claimed: true, owner: ATT }), nowMs: NOW }),
  };
  const ownerOk = Object.fromEntries(Object.entries(cases).map(([k, r]) => [k, r.owner.ok]));
  console.log('  MEASURED #1418 owner check:', JSON.stringify(ownerOk), 'team check with the attacker answering last:', cases.unsigned.checks.find((c) => c.key === 'outside').ok);
  assert.deepEqual(ownerOk, { unsigned: false, forged: false, staleReal: false, realOwner: true });
  assert.equal(cases.unsigned.passes, false);
  assert.equal(cases.unsigned.checks.find((c) => c.key === 'outside').ok, false, 'the team host is read where the node\'s signed word was served');
});

// KANBAN #1426 N7 (audit 6 re-check): a seat relaying a team node's signed word must not make it look outside - any team host that served it counts
test('#1426 N7 a team node\'s signed statement relayed by an outside seat is still a team node', async () => {
  const served = (url) => { const from = Number(new URL(url).searchParams.get('from')), dayAgo = Math.round((Math.floor(NOW / DAY) * DAY - from) / DAY);
    return { held: dayAgo >= 1 && dayAgo <= 7 ? [{ roundId: `r${dayAgo}`, committee: [NODE], finals: [NODE] }] : [] }; };
  const relayNewer = async (url) => (url.endsWith('/owner') ? (url.startsWith('https://relay.example') ? said(ME, NOW - 1000) : said(ME, NOW - 9000)) : served(url));
  const r = await nodeBountyCheck({ node: NODE, npub: ME, seats: ['https://node.example', 'https://relay.example'], fetchJson: relayNewer, nowMs: NOW, teamHosts: ['node.example'] });
  console.log('  MEASURED #1426 N7: team node relayed (newer copy) by an outside seat -> outside check', r.checks.find((c) => c.key === 'outside').ok);
  assert.equal(r.checks.find((c) => c.key === 'outside').ok, false);
});
