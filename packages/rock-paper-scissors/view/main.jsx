// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ROCK PAPER SCISSORS' TABLE, MOUNTED: window.RpsView.mount(view, { onTap }) answers { draw(state, { stage, stageFailed }) } - the
// client's draw hands each new state to it (only when the state changed, never under a finger: the client's paint decides that).
// Built as one plain script and inlined into the client file: the file's SHA-256 is its manifest's pin, so nothing is fetched.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { RpsView } from './RpsView.jsx';

export function mount(view, { onTap }) {
  const root = createRoot(view);
  let drawn = 0;
  return { draw(state, { stage = null, stageFailed = false } = {}) { drawn++;
    // AT ONCE, as the client's own drawing was: its paint reads what it drew (the stage's icons, the measurements) right after
    flushSync(() => root.render(<RpsView state={state} stage={stage} stageFailed={stageFailed} onTap={onTap} drawn={drawn} />)); } };
}
if (typeof window !== 'undefined') window.RpsView = { mount };
