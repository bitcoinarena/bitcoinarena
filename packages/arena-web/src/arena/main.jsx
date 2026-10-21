// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARENA PAGE'S REACT VIEWS, ONE BUNDLE (kanban #564): the market's pick sheet (window.ArenaMarket, ../market/main.jsx) and the games
// screen's tiles - window.ArenaGames.drawTiles(list, { tiles, verifyInfo, routed, onChoose, onChip, onSeason, onTip }) draws them into the
// page's #arena-games .list (a fresh root in a child of it: the page clears the list for its own screens). The page loads this file as a
// module beside its own script and keeps drawing everything itself when it is not there; React is in it once.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../market/main.jsx';
import { flushSync } from 'react-dom';
import { GameTiles } from './GameTiles.jsx';
import { SeasonRows } from './SeasonRows.jsx';
import { ZapCard } from './ZapCard.jsx';
import { ChipList } from './ChipList.jsx';
import { BalanceSplit } from './BalanceSplit.jsx';
import { ConfirmCard } from './ConfirmCard.jsx';

export function drawTiles(list, props) {
  const host = document.createElement('div');
  host.className = 'react-tiles';
  list.append(host);
  const root = createRoot(host);
  root.render(<GameTiles {...props} />);
  return root;
}
if (typeof window !== 'undefined') window.ArenaGames = { drawTiles };
// THE SEASON BOARD'S ROWS (the page's seasonBoard hands them over): drawn at once, so the page can watch the new rows right after
export function drawRows(board, props) {
  if (!board._root) board._root = createRoot(board);
  flushSync(() => board._root.render(<SeasonRows {...props} />));
}
if (typeof window !== 'undefined') window.ArenaSeason = { drawRows };
// THE ZAP BOX (the page's zaps block hands it what its own elements hold)
export function drawZap(host, props) {
  if (!host._root) host._root = createRoot(host);
  flushSync(() => host._root.render(<ZapCard {...props} />));
}
if (typeof window !== 'undefined') window.ArenaZap = { draw: drawZap };
// A TILE'S CHIP LIST (the page's ARENA_CHIP_LIST hands it its blocks): drawn into the popup's body, one root
export function drawChips(body, props) {
  if (!body._root) body._root = createRoot(body);
  flushSync(() => body._root.render(<ChipList {...props} />));
}
if (typeof window !== 'undefined') window.ArenaChips = { draw: drawChips };
// "YOUR BALANCE" BY FEDERATION (the page's paintSplit hands it the rows)
export function drawSplit(host, props) {
  if (!host._root) host._root = createRoot(host);
  flushSync(() => host._root.render(<BalanceSplit {...props} />));
}
if (typeof window !== 'undefined') window.ArenaBalance = { drawSplit };
// THE PAGE'S CONFIRMATIONS (its gates hand over the words; one answer each)
export function ask(host, props) {
  if (!host._root) host._root = createRoot(host);
  flushSync(() => host._root.render(<ConfirmCard key={Date.now()} {...props} />));
}
export function clear(host) { if (host._root) { host._root.unmount(); host._root = null; } }
if (typeof window !== 'undefined') window.ArenaConfirm = { ask, clear };
