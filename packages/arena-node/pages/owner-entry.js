// THE OWNER PAGE'S CRYPTO IN ONE FILE (kanban #276): BIP-39 words, the owner key and its signed requests, BIP-340.
// Bundled into pages/owner-client.js by tools/bundle-owner.mjs; test/owner.test.js holds the bundle to this source.
import { schnorr } from '@noble/curves/secp256k1.js';
export { phraseFromSeed, seedFromPhrase } from '../../arena-client/src/bip39.js';
export { ownerSecretFromSeed, signOwnerRequest } from '../src/owner.js';
export { toHex, fromHex } from '../../arena-protocol/src/hash.js';
export const sign = (message, secret) => schnorr.sign(message, secret);
export const pubkeyOf = (secret) => schnorr.getPublicKey(secret);
// SIGN NEW GAMES AND MARKETS (step 4): the owner's developer key from the same words, and the signer arena-donor's matches
export { devSeedFromSeed, devPubkeyOf, bodyFromJson, signManifestWithSeed } from '../src/owner-dev.js';
// THE PLUGIN STORE'S CHECKS IN THE PAGE (step 5, the owner 2026-10-10: "Everything with loading plugins must happen in the
// browser ... Malicious code checks are very important"): the report the owner reads before Install - the seat runs the same
export { checkPackage, checkUpdate, scanSource } from '../src/plugin-check.js';
import { ed25519 } from '@noble/curves/ed25519.js';
export const verifyEd25519 = (sig, msg, key) => { try { return ed25519.verify(sig, msg, key); } catch { return false; } };
