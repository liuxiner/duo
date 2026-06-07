#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
node scripts/sync-pdd-to-feishu.mjs
