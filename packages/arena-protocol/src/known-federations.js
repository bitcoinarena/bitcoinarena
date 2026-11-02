// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FEDERATIONS THIS CLIENT LETS A PLAYER DEPOSIT AND STAKE INTO WITHOUT ASKING (spec §23.6): "federation_id
// is on the client's known-good list, or the client shows it and its guardians and requires an explicit confirmation -
// the same rule as sim_wasm_hash (§5)". By federation id (the hash of its configuration). Adding one is a reviewed code
// change, like adding a game core to known-games.js - never a setting, a query parameter or a seat's word.
import { toHex } from './hash.js';
import { TEST_FEDERATION_ID } from './test-federation.js';

export const KNOWN_GOOD_FEDERATIONS = Object.freeze({
  // Bitcoin Arena testnet4: seven guardians, one per seat, 5 of 7 (§23A.1, RULED 2026-09-27); its record 
  '337ae01ad1e9bb35b5628faad3457e62d69d036efe8a34bcfc20cb31b42bb75e': Object.freeze({ name: 'Arena testnet4', network: 'testnet4', nominal: 7, threshold: 5 }),
  // Bitcoin Arena testnet4 B: the second federation, seven guardians on the test host, 5 of 7 (2026-10-13: "2
  // federations", "always take the federation with less funds"); its record signed by all 7, measured on the live page 22:45Z
  'b18947f085d40df3ce4bc8ac64df9c45256223e88fe7fdbdebf3eae13fb10b73': Object.freeze({ name: 'Arena testnet4 B', network: 'testnet4', nominal: 7, threshold: 5 }),
  // B's successor (kanban #326 step 5, 2026-10-20): seven guardians, 5 of 7 (its client config: 7 api endpoints); its record OPEN and signed by
  // 6 at 157,128 on every seat measured, B's record names it; gw-b holds 98,999 sat of its e-cash. A CRITICAL B's funds move here by themselves
  // NO NEW DEPOSITS (kanban #807, the owner 2026-11-02): what it holds stays and plays out; new money goes to A.
  '4dc88be70830d3619fd8742eaf639ab297774850cc68a203aad5b10a21e1fe98': Object.freeze({ name: 'Arena testnet4 B2', network: 'testnet4', nominal: 7, threshold: 5, noNewDeposits: true }),
  // the regtest stand-in every test and vector uses (test-federation.js) - never one that holds money
  [toHex(TEST_FEDERATION_ID)]: Object.freeze({ name: 'regtest test federation', network: 'regtest', nominal: 4, threshold: 3 }),
});

/** Is this federation on the list? `federationId` as 32 bytes or 64 hex. */
export function federationIsKnown(federationId) {
  const hex = federationId instanceof Uint8Array ? toHex(federationId) : String(federationId || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(KNOWN_GOOD_FEDERATIONS, hex);
}
/** Does this federation take new deposits? Money and rounds already there are not touched by this. `federationId` as 32 bytes or 64 hex. */
export function takesDeposits(federationId) {
  const hex = federationId instanceof Uint8Array ? toHex(federationId) : String(federationId || '').toLowerCase();
  return !(KNOWN_GOOD_FEDERATIONS[hex] && KNOWN_GOOD_FEDERATIONS[hex].noNewDeposits);
}
export const knownFederation = (hex) => KNOWN_GOOD_FEDERATIONS[String(hex || '').toLowerCase()] || null;
