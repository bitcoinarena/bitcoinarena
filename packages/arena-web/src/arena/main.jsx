// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARENA PAGE'S REACT VIEWS, ONE BUNDLE (kanban #564): the market's pick sheet (window.ArenaMarket, ../market/main.jsx) and the games
// screen's tiles - window.ArenaGames.drawTiles(list, { tiles, verifyInfo, routed, onChoose, onChip, onSeason, onTip }) draws them into the
// page's #arena-games .list (a fresh root in a child of it: the page clears the list for its own screens). The page loads this file as a
// module beside its own script and keeps drawing everything itself when it is not there; React is in it once.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../market/main.jsx';
import { GameTiles } from './GameTiles.jsx';

export function drawTiles(list, props) {
  const host = document.createElement('div');
  host.className = 'react-tiles';
  list.append(host);
  const root = createRoot(host);
  root.render(<GameTiles {...props} />);
  return root;
}
if (typeof window !== 'undefined') window.ArenaGames = { drawTiles };
