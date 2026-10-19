// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A KEPT VALUE MOVES TO ITS arena- NAME ONCE (kanban #522): the page kept donation records and liquidation claims under blwp- names.
// Before a key is read or written, `movedKey(storage, 'arena-…')` moves the value of its old 'blwp-…' twin: copied only when the arena-
// key holds nothing (a newer arena- value is never overwritten), and the old key removed either way - so a claim removed after it was
// paid cannot come back from its old copy on the next load. Answers the arena- key.
export function movedKey(storage, key) {
  if (!storage || typeof key !== 'string' || !key.startsWith('arena-')) return key;
  const old = 'blwp-' + key.slice('arena-'.length);
  try {
    const was = storage.getItem(old);
    if (was !== null && was !== undefined) {
      const now = storage.getItem(key);
      if (now === null || now === undefined) storage.setItem(key, was);
      storage.removeItem(old);
    }
  } catch { /* a storage that refuses: the key as it is */ }
  return key;
}
