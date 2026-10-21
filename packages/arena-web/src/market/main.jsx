// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PREDICTION MARKET'S REACT VIEWS ON THE ARENA PAGE (kanban #564): window.ArenaMarket.openSheet(box, { sheet, free, onPick, onCancel })
// draws market.js's pick sheet in the page's #arena-pick .sheet; btc-updown's market-page.js calls it when the page loaded this bundle and
// keeps its own sheet otherwise.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { PickSheet } from './MarketViews.jsx';

export function openSheet(box, { sheet, free = false, onPick, onCancel }) {
  if (box._react) box._react.unmount();
  box.textContent = '';
  box._react = createRoot(box);
  box._react.render(<PickSheet sheet={sheet} free={free} onPick={onPick} onClose={onCancel} />);
  return box._react;
}
if (typeof window !== 'undefined') window.ArenaMarket = { openSheet };
