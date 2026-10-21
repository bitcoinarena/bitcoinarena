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
import { WalletHistory } from './WalletHistory.jsx';
import { CustodyCard } from './CustodyCard.jsx';
import { SeedModal } from './SeedModal.jsx';
import { WalletStart } from './WalletStart.jsx';
import { NameCard, GraphicsCard, LogsCard, SeedCard, AccountCard } from './SettingsCards.jsx';

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
// THE WALLET'S HISTORY AND ITS FEDERATIONS BOX (the page's paintHistory and paintCustody hand over their rows)
const into = (el, node) => { if (!el._root) el._root = createRoot(el); flushSync(() => el._root.render(node)); };
export function drawHistory(el, props) { into(el, <WalletHistory {...props} />); }
export function drawCustody(el, props) { into(el, <CustodyCard {...props} />); }
if (typeof window !== 'undefined') window.ArenaWallet = { drawHistory, drawCustody };
// THE SEED PHRASE MODAL (the page's Settings opens it with the words and its own recording rule)
export function openSeed(host, props) { into(host, <SeedModal key={Date.now()} {...props} />); }
export function closeSeed(host) { if (host._root) { host._root.unmount(); host._root = null; } }
if (typeof window !== 'undefined') window.ArenaSeed = { open: openSeed, close: closeSeed };
// THE WALLET SCREEN (the page's wallet start hands it its rules: create, restore, the Nostr login)
export function openWalletStart(host, props) { into(host, <WalletStart {...props} />); }
if (typeof window !== 'undefined') window.ArenaWalletStart = { open: openWalletStart };
// SETTINGS' OWN CARDS: each drawn into its section with what the page hands it
if (typeof window !== 'undefined') window.ArenaSettings = {
  name: (host, props) => into(host, <NameCard {...props} />), graphics: (host, props) => into(host, <GraphicsCard {...props} />),
  logs: (host, props) => into(host, <LogsCard {...props} />), seed: (host, props) => into(host, <SeedCard {...props} />),
  account: (host, props) => into(host, <AccountCard {...props} />) };
