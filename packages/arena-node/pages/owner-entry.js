// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER PAGE'S CRYPTO IN ONE FILE: BIP-39 words, the owner key and its signed requests, BIP-340.
// Bundled into pages/owner-client.js by tools/bundle-owner.mjs; test/owner.test.js holds the bundle to this source.
import { schnorr } from '@noble/curves/secp256k1.js';
export { phraseFromSeed, seedFromPhrase } from '../../arena-client/src/bip39.js';
export { ownerSecretFromSeed, signOwnerRequest, nodeSeedFromNsecSecret } from '../src/owner.js';
export { toHex, fromHex } from '../../arena-protocol/src/hash.js';
export const sign = (message, secret) => schnorr.sign(message, secret);
export const pubkeyOf = (secret) => schnorr.getPublicKey(secret);
// SIGN NEW GAMES AND MARKETS (step 4): the owner's developer key from the same words, and the signer arena-donor's matches
export { devSeedFromSeed, devPubkeyOf, bodyFromJson, signManifestWithSeed } from '../src/owner-dev.js';
// THE PLUGIN STORE'S CHECKS IN THE PAGE (step 5, 2026-10-10: "Everything with loading plugins must happen in the
// browser ... Malicious code checks are very important"): the report the owner reads before Install - the seat runs the same
export { checkPackage, checkUpdate, scanSource } from '../src/plugin-check.js';
import { ed25519 } from '@noble/curves/ed25519.js';
export const verifyEd25519 = (sig, msg, key) => { try { return ed25519.verify(sig, msg, key); } catch { return false; } };
// THE NETWORK STORE'S CHECKS IN THE PAGE: federation invite, donation sets, series and chain, each against its
// own authority - the report the owner reads before Install; the seat runs the same and its trial
export { checkNetworkPackage, checkNetworkUpdate } from '../src/network-check.js';
// LOGIN WITH NOSTR: an owner request as a Nostr event, and the Nostr signers (extension, remote, nsec, new account)
export { signOwnerEvent } from '../src/owner.js';
export { extensionSigner, bunkerSigner, nostrConnect, signerFromNsec, newAccount, npubOf, textQrSvg } from '../../arena-client/nostr/entry.js';
// THE OWNER'S EMERGENCY CODE (spec §23A.5a, protocol 17): shown on the owner page from the words, and typed on /Dashboard/emergency of
// any node to take an offline node out - the key is made from the code in the browser and signs the request there
export { emergencyCodeBytes, emergencyCodeText, parseEmergencyCode, emergencySecret, signEmergencyDeparture, encodeEmergencyDeparture,
  EMERGENCY_FRESH_BLOCKS } from '../../arena-protocol/src/emergency.js';
