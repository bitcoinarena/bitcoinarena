// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CORE A LAUNCHED ROUND NAMES: the truck nextblock's versions 1-4 name, as the registration computes it.
//
// Every launcher used to write thirty-two bytes of 1 as the core - one that does not
// exist - and nothing refused it, because nothing checked. A page now refuses a
// paying round on a core that is not on its known-good list (§5), so a
// launcher names the real one. It was the sorted-source hash of this checkout's core/src
// until that tree became version 5's truck a5c5766a (kanban #523: 68e2b3d6 with its comments cleaned),
// which versions 1-4 do not list; the truck they list is the registration's TRUCK_CORE_HASH, its files
// frozen in nextblock/frozen/68e2b3d6 and checked against that hash when the registration is imported.
import { TRUCK_CORE_HASH } from '../../nextblock/plugin/truck-cores.js';

export const CORE_HASH = TRUCK_CORE_HASH;
