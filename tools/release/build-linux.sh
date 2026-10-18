#!/bin/bash
# The Linux assets (kanban #471): build-release.sh for linux. tools/release/build-linux.sh <version> <x64|arm64> <out dir> [commit]
exec "$(dirname "$0")/build-release.sh" "$1" linux "$2" "$3" "${4:-HEAD}"
