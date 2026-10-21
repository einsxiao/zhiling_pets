#!/usr/bin/env python3
"""seq_pipeline 启动器（避免嵌入式 Python 的 -m 找不到包）。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from seq_pipeline.cli import main  # noqa: E402

if __name__ == '__main__':
    sys.exit(main())
