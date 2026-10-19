// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// UNITY'S TEMPLATE IS src/arena-ui, BYTE FOR BYTE (kanban #521): every file of src/arena-ui sits in the Unity WebGL template unchanged,
// plus each game's page parts (packages/<game>/page/*-page.*) under games/<game>/, and the template holds nothing else but Unity's .meta files. A change to src/arena-ui without `node tools/sync-arena-ui.mjs` fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { differences } from '../../../tools/sync-arena-ui.mjs';

test('the Unity template is a copy of src/arena-ui (run tools/sync-arena-ui.mjs after a change)', () => {
  const d = differences();
  assert.deepEqual(d.copy, [], 'files of src/arena-ui missing or different in the template');
  assert.deepEqual(d.remove, [], 'files in the template that src/arena-ui does not have');
});
