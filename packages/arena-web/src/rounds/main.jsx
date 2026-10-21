// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ROUNDS PAGE IN REACT, MOUNTED (kanban #564): window.ArenaRounds.draw(element, data, readResult) draws /api/rounds into the page at
// every read (one root per element, the opened rounds kept); the page's only drawing (kanban #564: no fall backs).
import React from 'react';
import { createRoot } from 'react-dom/client';
import { RoundsPage } from './RoundsPage.jsx';

export function draw(element, data, readResult) {
  if (!element._root) element._root = createRoot(element);
  element._root.render(<RoundsPage data={data} readResult={readResult} />);
}
if (typeof window !== 'undefined') window.ArenaRounds = { draw };
