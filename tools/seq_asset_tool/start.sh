#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
    echo "[seq-asset-tool] 未找到 Node.js，请先安装 Node.js 18+。"
    exit 1
fi
exec node server.mjs --open
