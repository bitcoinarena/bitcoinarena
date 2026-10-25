// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EVERY GUARDIAN A FEDERATION'S INVITES NAME, ONE INVITE FOR A JOIN THAT COULD NOT READ THE CONFIG (2026-10-20 18:0xZ: "Fix the issue that it
// connects to a wallet/guardian that is offline" - federation 4dc88be7's invite named only fed2-8, whose guardian had stopped at 07:56Z, so
// every new wallet there failed with "Failed to download client config" while 6 of its 7 guardians ran). Every invite this client sees -
// a round's, a remembered one, each seat's federation record (read here even before the record can be verified: only the config is
// fetched with it, and the wallet checks that config against the federation id, its hash) - adds its guardians; a join that cannot read
// the config is tried once more with an invite naming all of them, so one guardian down no longer keeps a player out.
import { readInvite, inviteForGuardians } from '../../arena-node/src/invite.js';
import { splitSignedRecord } from '../../arena-protocol/src/federation-record.js';

const seen = new Map();   // federation id hex -> Map(peer id -> url), the first url named for a peer kept

export function noteInvite(invite) {
  let r; try { r = readInvite(invite); } catch { return false; }
  if (!r.federationId) return false;
  const m = seen.get(r.federationId) || new Map();
  for (const g of r.guardians) if (!m.has(g.peer)) m.set(g.peer, g.url);
  seen.set(r.federationId, m);
  return true;
}

/** A seat's signed federation record (hex), verified or not: its invite's guardians are noted. */
export function noteRecordInvite(recordHex) {
  try {
    const bytes = Uint8Array.from(String(recordHex).match(/../g).map((x) => parseInt(x, 16)));
    return noteInvite(splitSignedRecord(bytes).record.invite);
  } catch { return false; }
}

/** An invite naming every guardian noted for `invite`'s federation, when that is more than `invite` names - else null. */
export function wholeInvite(invite) {
  let r; try { r = readInvite(invite); } catch { return null; }
  if (!r.federationId) return null;
  noteInvite(invite);
  const m = seen.get(r.federationId);
  if (!m || m.size <= new Set(r.guardians.map((g) => g.peer)).size) return null;
  const guardians = [...m].map(([peer, url]) => ({ peer, url })).sort((a, b) => a.peer - b.peer);
  const id = Uint8Array.from(r.federationId.match(/../g).map((x) => parseInt(x, 16)));
  try { return inviteForGuardians(id, guardians); } catch { return null; }
}

export const forgetGuardianInvites = () => seen.clear();   // tests
