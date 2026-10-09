// THE TEST UP/DOWN MARKET (kanban #236, the owner 2026-10-09): Polymarket's BTC Up or Down 15m as a Bitcoin Arena market - one
// round per UTC quarter hour (its manifest's period, 900 000 ms), Up when the window's TWAP is at or above the price at its
// start (a tie Up), outcome by 2 of its 3 attestors, refused before the window's end, VOID 10 minutes after it with no
// outcome. Its developer and attestor keys are TEST keys (testDevKey's words): regtest only.
import { testAttestedGame, testDevKey } from '../sign.js';
import { UP_DOWN_OUTCOMES } from '../../../../arena-protocol/src/up-down.js';

export const UPDOWN_PERIOD_MS = 900000n;
export const UPDOWN_TERMS = Object.freeze({
  nodeFeeBps: 50, donationBps: 50,
  question: 'Will the BTC/USD time-weighted average price over this 15-minute window be at or above the price at its start?',
  resolveAfterCloseMs: 0n, deadlineAfterResolveMs: 600000n,
  sourceRule: 'Each attestor reads BTC/USD every 10 s from three public exchanges (A, B: Coinbase, Kraken, Bitstamp; C: Gemini, '
    + 'Coinbase, Kraken) and keeps the median in whole cents. The price to beat is the reading in force at the window\'s start; '
    + 'the window\'s TWAP weights each reading by how long it stood inside the window. Up if TWAP >= price to beat (a tie is Up), '
    + 'else Down. Signed at the window\'s end (observed_at = the window\'s end); 2 of 3 attestors.',
});
// the attestors' words, in the order A, B, C (the manifest lists their keys sorted)
export const UPDOWN_ATTESTOR_WORDS = Object.freeze(['updown attestor A', 'updown attestor B', 'updown attestor C']);
export const UPDOWN = testAttestedGame({ name: 'btc-updown-15m', outcomes: [...UP_DOWN_OUTCOMES], attestors: [...UPDOWN_ATTESTOR_WORDS],
  threshold: 2, marketTerms: UPDOWN_TERMS, roundPeriodMs: UPDOWN_PERIOD_MS });
/** Each attestor's key by its letter: { A: { key, pubkey }, ... } (testDevKey of `attestor: <word>`, as testAttestedGame derives them). */
export const UPDOWN_ATTESTOR_KEYS = Object.freeze(Object.fromEntries(UPDOWN_ATTESTOR_WORDS.map((w) => [w.slice(-1), testDevKey(`attestor: ${w}`)])));
