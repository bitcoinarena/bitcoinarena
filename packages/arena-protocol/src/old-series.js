// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// PICK B (RULED 2026-09-30 08:55, OLD-BEACON-0850): ONE NAMED EXCEPTION TO THE NETWORK IDENTITY AND TO THE SERIES
// LEAD AND GRID RULES, FOR ONE SERIES.
//
// Series 3cfbe516d93ddf4b was published on testnet4 (3029fc6f, block 154237; beacon 154268; committee_time 2026-09-28
// 19:52:05Z; start 2026-09-29 19:52:05Z) under the testnet4 network id as it stood then, 26b9162e... . 04c5ecec made
// genesis_series_start a genesis parameter the next day, which moved testnet4's id to bf876cb1... and put its series
// grid at 2026-10-01 - so every node refused this series as another network's, off the grid, and held to the 72 h lead a
// network nobody knows gets (a node loading it exited). Ruled: the current code accepts THIS series from the old id,
// beside bf876cb1; 24 h before its start (testnet4's own lead) is enough; beacon 154268 still counts. Nothing else of the
// old id is taken: a round naming it that is not a round of this series is refused (server.js POST /round).
import { fromHex } from './hash.js';

/** testnet4's network id before genesis_series_start (04c5ecec): the id series 3cfbe516 names. */
export const NETWORK_ID_TESTNET4_BEFORE_SERIES_GENESIS = fromHex('26b9162e72a397a4433f3cae8ea213a9a3fc2094bc04c1789a91b691edc9f62f');

/** The one series of that id the current code takes. */
export const OLD_TESTNET4_SERIES_ID = fromHex('3cfbe516d93ddf4bd2ca31c4fff6bd1dbe2dc4154e05fb7f184f1a5fd5a16d93');

const sameId = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((x, i) => x === b[i]);
export const isOldTestnet4Id = (networkId) => sameId(networkId, NETWORK_ID_TESTNET4_BEFORE_SERIES_GENESIS);
export const isOldTestnet4Series = (seriesIdBytes) => sameId(seriesIdBytes, OLD_TESTNET4_SERIES_ID);

/**
 * ITS CENSUS AS ITS PUBLISHER READ IT (the same ruling, measured 2026-09-30): the series names census root 726a0b87...,
 * which the 2026-09-28 runner derived from a view starting at its bonds' floor - 20 = 154152: the seven bonds at 154172.
 * A node's 2016-block lookback also sees each key's earlier bond at 154120 - fourteen entries, root a86ea4e0... - and
 * refused every round of the series. For this series alone the census is read from 154152, as published. The committee
 * is the same seven keys either way (one key, one seat).
 */
export const OLD_TESTNET4_SERIES_CENSUS_FROM = 154152;

/**
 * ITS FEDERATION'S BONDING, READ WHERE THE GUARDIANS ARE NAMED (the same ruling, measured 2026-09-30): §23.6 takes a paying
 * round only on a federation whose guardians are bonded - guardian_of[] in the census's advertisements. The series'
 * census (154206) predates the advertisement updates that name each node's guardian (154282), so every node refused its
 * rounds "on an unbonded federation" while the guardians are bonded on the chain. For this series alone the bonding is
 * read from the census at this fixed height, after those updates; its committee stays its own census's.
 */
export const OLD_TESTNET4_SERIES_BOND_HEIGHT = 154300;
