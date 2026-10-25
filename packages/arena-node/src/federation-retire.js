// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// RETIRING A FEDERATION THAT HOLDS NOTHING (kanban #577, 2026-10-22: "1" - a federation can be retired; then its guardians are
// free for the next founding). §23A had no way to end a federation but a succession (its guardians seated first in the successor) or a
// halt (a failure, then a liquidation). A retirement is neither: a federation whose guardians' own audit says it holds nothing - no
// e-cash issued, no coins in its wallet, nothing in Lightning contracts - is closed by a record its guardians sign as for any other
// status: CLOSED, with no successor. Every seat then reads it CLOSED, and its guardians guard no OPEN federation any more.
//
//   consent   each guardian's OWNER asks for it (POST /owner/federation/retire, signed, typed RETIRE), and only while its guardian's audit
//             holds nothing; the consent is kept beside the node (<store>.retire.json). A seat builds the record CLOSED only for a
//             federation its owner consented to retire, so the record stands once a threshold of owners did (federation-records.js).
//   after     the record stands CLOSED with no successor: the node sets its guardian of that federation aside (the directory kept, renamed)
//             and starts a guardian in setup, so it can be drawn into the next founding (node-start.js guardianControl.retire).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Does a guardian's `admin audit` say the federation holds nothing? Every module at net assets 0, and the total too. */
export function holdsNothing(audit) {
  if (!audit || typeof audit !== 'object' || !audit.module_summaries) return { ok: false, why: 'no audit to read' };
  const held = Object.values(audit.module_summaries).filter((m) => Number(m && m.net_assets) !== 0)
    .map((m) => `${m.kind} ${m.net_assets} msat`);
  if (held.length || Number(audit.net_assets) !== 0) return { ok: false, why: `the federation still holds something: ${held.join(', ') || `net ${audit.net_assets} msat`}` };
  return { ok: true };
}

/** The federation a guardian's directory guards: the id its invite-code names (`readInvite` the caller's parser), or null. */
export function guardedFederationOf(dataDir, readInvite) {
  try { return readInvite(readFileSync(join(dataDir, 'invite-code'), 'utf8').replace(/["\s]/g, '')).federationId.toLowerCase(); } catch { return null; }
}

/**
 * THE GUARDIAN'S OWN AUDIT of its federation: fedimint-cli joined once in <dataDir>.audit-client by the guardian's invite, then
 * `admin audit` as this guardian (--our-id from its local.json, its admin password). `run(args)` runs fedimint-cli and resolves its stdout.
 */
export async function auditGuardian({ run, dataDir }) {
  const client = `${dataDir}.audit-client`;
  const invite = readFileSync(join(dataDir, 'invite-code'), 'utf8').replace(/["\s]/g, '');
  const local = JSON.parse(readFileSync(join(dataDir, 'local.json'), 'utf8'));
  const ourId = local.identity !== undefined ? local.identity : local.our_id;
  if (ourId === undefined) throw new Error('the guardian\'s local.json names no identity');
  if (!existsSync(join(client, 'client.db'))) { mkdirSync(client, { recursive: true }); await run(['--data-dir', client, 'join', invite]); }
  const out = await run(['--data-dir', client, '--our-id', String(ourId), '--password', readFileSync(join(dataDir, 'admin-password'), 'utf8').trim(), 'admin', 'audit']);
  return JSON.parse(String(out));
}

/** The owners' consents, kept in one JSON file: federation id hex -> { atMs }. */
export function createRetireBook(file) {
  let book = {};
  try { if (file) book = JSON.parse(readFileSync(file, 'utf8')) || {}; } catch { book = {}; }
  const save = () => { if (file) { try { writeFileSync(file, JSON.stringify(book)); } catch { /* kept in memory */ } } };
  return {
    has: (fid) => Object.prototype.hasOwnProperty.call(book, String(fid).toLowerCase()),
    add: (fid, info = {}) => { book[String(fid).toLowerCase()] = { atMs: Date.now(), ...info }; save(); },
    done: (fid) => { const k = String(fid).toLowerCase(); if (book[k]) { book[k].retiredAtMs = Date.now(); save(); } },
    list: () => Object.entries(book).map(([federation, v]) => ({ federation, ...v })),
  };
}
