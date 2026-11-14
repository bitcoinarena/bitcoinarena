// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2774 (feedback #074): the duty poster's catalog (duty-guard.js catalogOf, read from census seats' GET /games) takes only manifests
// their developer signed. One seat listing the real app's name and developer key at version 9999 with a zero signature made that forged
// version "the newest" (duty-day.js familyIds), every real round of the day counted as not drawn, and duty nodes paid for emergency grids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogOf } from '../src/duty-guard.js';
import { decodeManifest, encodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { RPS_MANIFEST_HEX } from '../../rock-paper-scissors/plugin/rps-manifest.js';

test('a forged, unsigned top version of a real app is not in the duty catalog; the signed one is', () => {
  const real = decodeManifest(fromHex(RPS_MANIFEST_HEX));
  const forged = { ...real, version: 9999, parentManifestId: gameIdOf(real), signature: new Uint8Array(64) };
  const forgedHex = toHex(encodeManifest(forged));
  const listings = [{ games: [{ id: toHex(gameIdOf(forged)), manifest: forgedHex }, { id: toHex(gameIdOf(real)), manifest: RPS_MANIFEST_HEX }] }];
  const cat = catalogOf(listings, { decode: decodeManifest, idOf: gameIdOf });
  const rps = [...cat.values()].filter((g) => g.name === real.gameName);
  assert.deepEqual(rps.map((g) => g.version), [real.version], 'only the signed version stands');
});
