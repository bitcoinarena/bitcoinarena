#!/bin/bash
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# The Linux assets (kanban #471): build-release.sh for linux. tools/release/build-linux.sh <version> <x64|arm64> <out dir> [commit]
exec "$(dirname "$0")/build-release.sh" "$1" linux "$2" "$3" "${4:-HEAD}"
