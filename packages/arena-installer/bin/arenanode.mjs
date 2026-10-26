#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OLD NAME (kanban #688, 2026-10-26: "Rename the directories and binaries to bitcoinarena, not arenanode everywhere"): the command is
// bin/bitcoinarena.mjs. This file stays because the update code of 2026.1.9.7 and older writes <home>/bin/arenanode naming it in the
// release it moves the node to; its first run writes <home>/bin/bitcoinarena (launchers.js ensureCommand).
await import('./bitcoinarena.mjs');
