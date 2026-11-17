// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE GAME'S OWN NOSTR RELAY (kanban #2916): wss://relay.bitcoinarena.io. #937 moved the site to bitcoinarena.io; the relay kept
// its old name wss://relay.bitcoin-arena.io until #2916. The old host stays up as an ALIAS of the same relay: a WebSocket client
// does not follow an HTTP redirect, and events already signed (NIP-65 relay lists, badge awards, zap requests) name the old URL
// and cannot be signed again. So a list may name both - they are one relay, counted once, under the new name.

export const ARENA_RELAY = 'wss://relay.bitcoinarena.io';
export const ARENA_RELAY_OLD = 'wss://relay.bitcoin-arena.io';

const OLD_HOST = /^(wss?:\/\/)relay\.bitcoin-arena\.io(?=[:/?#]|$)/i;

/** One relay URL under its current name: the old host of the game's relay becomes the new one; any other URL is left as it is. */
export const canonicalRelay = (url) => String(url).replace(OLD_HOST, (_, scheme) => `${scheme}relay.bitcoinarena.io`);

/** A relay list without repeats, the game's relay under its current name, in the order first named. */
export const relaySet = (urls) => [...new Set([...urls].map(canonicalRelay))];
