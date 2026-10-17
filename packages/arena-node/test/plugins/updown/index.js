// THE TEST UP/DOWN MARKET (kanban #236, the owner 2026-10-09): Polymarket's BTC Up or Down 15m as a Bitcoin Arena market - one
// round per UTC quarter hour (its manifest's period, 900 000 ms), Up when the 60 s average at the window's end is at or above
// the 60 s average at its start (a tie Up; Chainlink's TWAP 60 s stream read at both ends, kanban #236 comment 1154), outcome by 2 of its 3 attestors, refused before the window's end, VOID 10 minutes after it with no
// outcome. Its developer and attestor keys are TEST keys (testDevKey's words): regtest only.
import { createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { readFileSync } from 'node:fs';
import { testAttestedGame, testDevKey } from '../sign.js';
import { UP_DOWN_OUTCOMES } from '../../../../arena-protocol/src/up-down.js';

export const UPDOWN_PERIOD_MS = 900000n;
export const UPDOWN_TERMS = Object.freeze({
  nodeFeeBps: 50, donationBps: 50,
  question: 'Will BTC/USD be at or above, at the end of this 15-minute window, the price at its start?',
  resolveAfterCloseMs: 0n, deadlineAfterResolveMs: 600000n,
  sourceRule: 'Each attestor reads BTC/USD every 10 s from three public exchanges (A, B: Coinbase, Kraken, Bitstamp; C: Gemini, '
    + 'Coinbase, Kraken) and keeps the median in whole cents. The price to beat is the time-weighted average of the readings over '
    + 'the 60 s before the window\'s start; the end price is the same 60 s average before its end. Up if end price >= price to '
    + 'beat (a tie is Up), else Down. Signed at the window\'s end (observed_at = the window\'s end); 2 of 3 attestors.',
});
// the attestors' words, in the order A, B, C (the manifest lists their keys sorted)
export const UPDOWN_ATTESTOR_WORDS = Object.freeze(['updown attestor A', 'updown attestor B', 'updown attestor C']);
// THE MARKET'S OWN CLIENT (kanban #237 step 2), pinned by its hash: the Arena page runs only these bytes for this market
// The bytes manifests v1 (672415c8) and v2 (f5f3f187) pin are kept as client/index-v2.html; client/index.html is the newest
// client, version 3's (kanban #388: the back button on its own row, the title on its own line, as Rock Paper Scissors')
export const UPDOWN_CLIENT_FILE = new URL('./client/index-v2.html', import.meta.url);
export const UPDOWN_CLIENT_HASH = createHash('sha256').update(readFileSync(UPDOWN_CLIENT_FILE)).digest();
// version 3's client (#388) is kept as client/index-v3.html; version 4's ("← Arena", kanban #396) as client/index-v4.html;
// version 5's (an order's progress in the sheet, a joinable window first - kanban #438) as client/index-v5.html; client/index.html is
// version 6's (My orders as cards, each with its result - kanban #443)
export const UPDOWN_CLIENT_V3_FILE = new URL('./client/index-v3.html', import.meta.url);
export const UPDOWN_CLIENT_V3_HASH = createHash('sha256').update(readFileSync(UPDOWN_CLIENT_V3_FILE)).digest();
export const UPDOWN_CLIENT_V4_FILE = new URL('./client/index-v4.html', import.meta.url);
export const UPDOWN_CLIENT_V4_HASH = createHash('sha256').update(readFileSync(UPDOWN_CLIENT_V4_FILE)).digest();
export const UPDOWN_CLIENT_V5_FILE = new URL('./client/index-v5.html', import.meta.url);
export const UPDOWN_CLIENT_V5_HASH = createHash('sha256').update(readFileSync(UPDOWN_CLIENT_V5_FILE)).digest();
export const UPDOWN_CLIENT_V6_FILE = new URL('./client/index.html', import.meta.url);
export const UPDOWN_CLIENT_V6_HASH = createHash('sha256').update(readFileSync(UPDOWN_CLIENT_V6_FILE)).digest();
// ITS DONATION KEY IS A POINT ON THE CURVE (kanban #237, measured on the regtest stack: the settlement failed with
// "blwp-stake-lock: Error: malformed public key"): sign.js testDonationSet takes 0x02 || sha256(word), an x that is on the
// curve only half the time; this market's key is the public key of a test secret, so a payout to it can be made
export const UPDOWN_DONATION_SET = Object.freeze([{ recipientPk: secp256k1.getPublicKey(createHash('sha256').update('test game donation key: btc-updown-15m').digest(), true),
  label: 'btc-updown-15m dev', shareBps: 10000 }]);
export const UPDOWN = testAttestedGame({ name: 'btc-updown-15m', outcomes: [...UP_DOWN_OUTCOMES], attestors: [...UPDOWN_ATTESTOR_WORDS],
  threshold: 2, marketTerms: UPDOWN_TERMS, roundPeriodMs: UPDOWN_PERIOD_MS, clients: [new Uint8Array(UPDOWN_CLIENT_HASH)], donationSet: UPDOWN_DONATION_SET });
/** Each attestor's key by its letter: { A: { key, pubkey }, ... } (testDevKey of `attestor: <word>`, as testAttestedGame derives them). */
export const UPDOWN_ATTESTOR_KEYS = Object.freeze(Object.fromEntries(UPDOWN_ATTESTOR_WORDS.map((w) => [w.slice(-1), testDevKey(`attestor: ${w}`)])));
