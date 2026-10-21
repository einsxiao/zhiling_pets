#!/usr/bin/env bash
# 优先使用工作台「安装依赖（.venv）」创建的虚拟环境，其次用 PATH 里的 python3
set -euo pipefail
cd "$(dirname "$0")"
PY="$(pwd)/.venv/bin/python"
if [ ! -x "$PY" ]; then
  PY=python3
fi
exec "$PY" ./run_pipeline.py "$@"
