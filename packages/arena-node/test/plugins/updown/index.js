// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE TEST UP/DOWN MARKET (kanban #236, Daniel 2026-10-09): Polymarket's BTC Up or Down 15m as a Bitcoin Arena market - one
// round per UTC quarter hour (its manifest's period, 900 000 ms), Up when the 60 s average at the window's end is at or above
// the 60 s average at its start (a tie Up; Chainlink's TWAP 60 s stream read at both ends, kanban #236 comment 1154), outcome by 2 of its 3 attestors, refused before the window's end, VOID 10 minutes after it with no
// outcome. Its developer and attestor keys are TEST keys (testDevKey's words): regtest only.
import { createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { testAttestedGame, testDevKey } from '../sign.js';
import { UP_DOWN_OUTCOMES } from '../../../../arena-protocol/src/up-down.js';

// the market itself is the game's own (packages/btc-updown/plugin/market-terms.js, kanban #568); this fixture adds its test keys
export { UPDOWN_PERIOD_MS, UPDOWN_TERMS, UPDOWN_ATTESTOR_WORDS, UPDOWN_CLIENT_FILE, UPDOWN_CLIENT_HASH, UPDOWN_CLIENT_V3_FILE, UPDOWN_CLIENT_V3_HASH, UPDOWN_CLIENT_V4_FILE, UPDOWN_CLIENT_V4_HASH, UPDOWN_CLIENT_V5_FILE, UPDOWN_CLIENT_V5_HASH, UPDOWN_CLIENT_V6_FILE, UPDOWN_CLIENT_V6_HASH, UPDOWN_CLIENT_V7_FILE, UPDOWN_CLIENT_V7_HASH, UPDOWN_CLIENT_V8_FILE, UPDOWN_CLIENT_V8_HASH, UPDOWN_CLIENT_V9_FILE, UPDOWN_CLIENT_V9_HASH, UPDOWN_CLIENT_V10_FILE, UPDOWN_CLIENT_V10_HASH, UPDOWN_CLIENT_V11_FILE, UPDOWN_CLIENT_V11_HASH, UPDOWN_CLIENT_V12_FILE, UPDOWN_CLIENT_V12_HASH, UPDOWN_CLIENT_V13_FILE, UPDOWN_CLIENT_V13_HASH, UPDOWN_CLIENT_V14_FILE, UPDOWN_CLIENT_V14_HASH, UPDOWN_CLIENT_V15_FILE, UPDOWN_CLIENT_V15_HASH } from '../../../../btc-updown/plugin/market-terms.js';
import { UPDOWN_PERIOD_MS, UPDOWN_TERMS, UPDOWN_ATTESTOR_WORDS, UPDOWN_CLIENT_HASH } from '../../../../btc-updown/plugin/market-terms.js';
// ITS DONATION KEY IS A POINT ON THE CURVE (kanban #237, measured on the regtest stack: the settlement failed with
// "arena-stake-lock: Error: malformed public key"): sign.js testDonationSet takes 0x02 || sha256(word), an x that is on the
// curve only half the time; this market's key is the public key of a test secret, so a payout to it can be made
export const UPDOWN_DONATION_SET = Object.freeze([{ recipientPk: secp256k1.getPublicKey(createHash('sha256').update('test game donation key: btc-updown-15m').digest(), true),
  label: 'btc-updown-15m dev', shareBps: 10000 }]);
export const UPDOWN = testAttestedGame({ name: 'btc-updown-15m', outcomes: [...UP_DOWN_OUTCOMES], attestors: [...UPDOWN_ATTESTOR_WORDS],
  threshold: 2, marketTerms: UPDOWN_TERMS, roundPeriodMs: UPDOWN_PERIOD_MS, clients: [new Uint8Array(UPDOWN_CLIENT_HASH)], donationSet: UPDOWN_DONATION_SET });
/** Each attestor's key by its letter: { A: { key, pubkey }, ... } (testDevKey of `attestor: <word>`, as testAttestedGame derives them). */
export const UPDOWN_ATTESTOR_KEYS = Object.freeze(Object.fromEntries(UPDOWN_ATTESTOR_WORDS.map((w) => [w.slice(-1), testDevKey(`attestor: ${w}`)])));
