// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARENA PAGE'S REACT LINES AS A TEST SEES THEM (kanban #564): the page draws its lines of words with window.ArenaText.say(element, text)
// and its history chip and backup box with window.ArenaBits (arena-react.js); a test that lifts the page's code hands these in - each
// element ends up holding the words React would draw there (its textContent), and `drawn` keeps what it was handed.
export const ArenaText = { say: (el, t) => { if (el) el.textContent = t === undefined || t === null ? '' : String(t); } };
export const ArenaBits = {
  fedChip: (el, p) => { if (el) { el.textContent = p.fed ? 'Federation ' + p.fed.slice(0, 8) + '…' + p.fed.slice(-4) : (p.say || ''); el.drawn = p; } },
  backup: (el, p) => { if (el) { el.textContent = p.line; el.drawn = p; } },
};
