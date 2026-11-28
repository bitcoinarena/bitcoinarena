#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# THE CUSTODY CARRIES THE LIQUIDATION PATCH (kanban #3910): packages/arena-node/tools/fedimint-spent-nonces.patch gives fedimintd the admin endpoint
# blwp_spent_nonces (a guardian's spent set, §23A.5 step 1) and fedimint-cli `module mintv2 validate | pending-outputs | check-pending` (the arbiter's
# check of a liquidation claim). custody-d7d91d1e lacked it: no guardian could publish a spent set and the claims door answered 422 for real notes.
# Offline and for every platform (the binaries are not run): each must hold the names the patch adds.
# usage: custody-check.sh <fedimintd> <fedimint-cli>   (exit 1 names what is missing)
set -u
bad=0
need() { LC_ALL=C grep -a -q -- "$2" "$1" || { echo "$1: lacks '$2' - not built with fedimint-spent-nonces.patch (kanban #3910)" >&2; bad=1; }; }
need "$1" blwp_spent_nonces
need "$2" check-pending
need "$2" pending-outputs
exit $bad
