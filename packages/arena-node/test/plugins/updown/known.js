// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// The Up/Down test market's entry for the client's known-games list (arena-protocol/tools/known-games.js; kanban #237): its
// signed manifest, and the one network it is pinned for - regtest. Its developer and attestor keys come from public test
// words; pinned anywhere else, anybody could attest its outcome.
import { encodeManifest } from '../../../../arena-protocol/src/manifest.js';
import { toHex } from '../../../../arena-protocol/src/hash.js';
import { NETWORK_ID_REGTEST } from '../../../../arena-protocol/src/genesis-ids.js';
import { UPDOWN } from './index.js';

export const KNOWN_GAME = Object.freeze({ manifestHex: toHex(encodeManifest(UPDOWN.registration.manifest)), sharedWorld: [], networks: [toHex(NETWORK_ID_REGTEST)] });
