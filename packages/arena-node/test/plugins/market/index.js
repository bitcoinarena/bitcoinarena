// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A MARKET AS A PLUGIN (kanban #206, §0A.7a): "btc-close" - three outcomes, three attestor keys derived from public test
// words, two of them to sign; no core, no run, the pari-mutuel rule. A TEST market: its attestors' keys are anybody's, so it
// is pinned in the client's known-games list for REGTEST only (known.js), never for testnet4 or mainnet.
// ITS DEV'S DONATION KEY IS A REAL POINT (a test secret's public key): a real federation's lock client builds the payout
// contract to it - measured on regtest, a set of `0x02 || hash` was refused there as "malformed public key".
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { testAttestedGame } from '../sign.js';

export const MARKET_OUTCOMES = Object.freeze(['above 100k', 'between', 'below 90k']);
const donationSecret = createHash('sha256').update('btc-close test market: its dev\'s donation key').digest();
export const MARKET_DONATION_SET = Object.freeze([{ recipientPk: secp256k1.getPublicKey(donationSecret, true), label: 'btc-close dev', shareBps: 10000 }]);
// ITS OWN CLIENT (kanban #208): client/index.html, pinned by its SHA-256 in the manifest's clients[] - the page runs it only
// from bytes that hash to it (arena-client games.js gameClientFile), served at games/btc-close/index.html
export const MARKET_CLIENT_PATH = new URL('./client/index.html', import.meta.url);
export const MARKET_CLIENT_HASH = new Uint8Array(createHash('sha256').update(readFileSync(MARKET_CLIENT_PATH)).digest());
export const MARKET = testAttestedGame({ name: 'btc-close', outcomes: [...MARKET_OUTCOMES], donationSet: MARKET_DONATION_SET, clients: [MARKET_CLIENT_HASH] });
