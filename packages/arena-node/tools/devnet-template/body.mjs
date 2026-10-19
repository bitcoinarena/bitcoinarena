// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// __TITLE__: THE MANIFEST BODY (made from the devnet's game template, packages/arena-node/tools/devnet-template). Your signed
// record of the game: its rules (the core's hash and the configs it may run), its run length, how it pays, its clients and
// whose donation set its share goes to. Signed by your developer key with the dev client:
//   node packages/arena-donor/bin/arena-donor.mjs sign <this dir>/dev <this dir>/body.mjs
// which writes dev/__NAME__-manifest.hex; the hash of the signed manifest is your game id (manifest.js gameIdOf). Change
// anything here and sign again: a new manifest is a new game id - an update of a released game is `version` + 1 with the
// old id as `parentManifestId`, signed by the same key.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RESULT_TYPE, PAYOUT_RULE, NO_PARENT } from '__PROTOCOL__/manifest.js';
import { donationSetId } from '__PROTOCOL__/donation.js';

const here = (f) => new URL(f, import.meta.url);
const sha256 = (b) => createHash('sha256').update(b).digest();

/** THE CORE: core.js beside this file, named by the SHA-256 of its bytes (core-sandbox.js checks it before it runs a line). */
export const CORE_HASH = sha256(readFileSync(here('./core.js'))).toString('hex');
/** ONE CONFIG: the rule numbers a round may name for this core, by their hash. This game has none, so it hashes its name. */
export const CONFIG = Object.freeze({});
export const CONFIG_HASH = sha256(Buffer.from('__NAME__ config 1')).toString('hex');
/** YOUR DONATION SET: the dev client key `arena-donor init` made (dev/key.json, its public half), all of the game's share. */
export const DONATION_SET = [{ recipientPk: Uint8Array.from(Buffer.from(JSON.parse(readFileSync(here('./dev/key.json'), 'utf8')).recipientPkHex, 'hex')),
  shareBps: 10000, label: '__NAME__ dev' }];

export const BODY = {
  gameName: '__NAME__', version: 1, parentManifestId: NO_PARENT,
  // A REPLAYED GAME: every node replays each run with the core, and the rank curve pays the best runs
  resultType: RESULT_TYPE.REPLAY, payoutRule: PAYOUT_RULE.RANK_CURVE, rankNumerator: 3, rankDenominator: 4,
  minScore: 1, runTicksMax: 600, roundPeriodMs: 0n,
  cores: [{ hash: Uint8Array.from(Buffer.from(CORE_HASH, 'hex')), configs: [Uint8Array.from(Buffer.from(CONFIG_HASH, 'hex'))] }],
  // THE PAGES PLAYERS PLAY IT IN, by the SHA-256 of each (games/__NAME__/index.html beside the Arena page); none yet
  clients: [],
  gameDonationSetId: donationSetId(DONATION_SET),
};
