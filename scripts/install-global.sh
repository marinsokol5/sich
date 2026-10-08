#!/bin/sh
# Install the current checkout as the global `sich`, packed exactly as it would
# be published. Only needed until sich is on npm; after that: pnpm add -g sich
set -e
cd "$(dirname "$0")/.."
SICH_DEV=true pnpm run build   # stamps "-dev" into `sich --version`
dir=$(mktemp -d)
pnpm pack --pack-destination "$dir" >/dev/null
pnpm add -g "$dir"/sich-*.tgz
rm -rf "$dir"
