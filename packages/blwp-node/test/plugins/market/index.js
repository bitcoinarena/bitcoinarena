// A MARKET AS A PLUGIN (kanban #206, §0A.7a): "btc-close" - three outcomes, three attestor keys derived from public test
// words, two of them to sign; no core, no run, the pari-mutuel rule. A TEST market: its attestors' keys are anybody's, so it
// is pinned in the client's known-games list for REGTEST only (known.js), never for testnet4 or mainnet.
// ITS DEV'S DONATION KEY IS A REAL POINT (a test secret's public key): a real federation's lock client builds the payout
// contract to it - measured on regtest, a set of `0x02 || hash` was refused there as "malformed public key".
import { createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { testAttestedGame } from '../sign.js';

export const MARKET_OUTCOMES = Object.freeze(['above 100k', 'between', 'below 90k']);
const donationSecret = createHash('sha256').update('btc-close test market: its dev\'s donation key').digest();
export const MARKET_DONATION_SET = Object.freeze([{ recipientPk: secp256k1.getPublicKey(donationSecret, true), label: 'btc-close dev', shareBps: 10000 }]);
export const MARKET = testAttestedGame({ name: 'btc-close', outcomes: [...MARKET_OUTCOMES], donationSet: MARKET_DONATION_SET });
