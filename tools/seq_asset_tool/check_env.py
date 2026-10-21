#!/usr/bin/env python3
"""check_env.py — 检查绿幕流水线的 Python 依赖是否齐备。

由工作台 server.mjs 调用（探测候选解释器），也可手动执行：

    python check_env.py

输出一行 JSON，便于程序解析：

    {"ok": true, "executable": "...", "version": "3.12.3",
     "modules": {"cv2": "5.0.0", "numpy": "2.5.3", "PIL": "11.0.0"},
     "missing": []}

缺少依赖时 ok=false，missing 中列出模块、对应 pip 包名与导入错误。
"""
from __future__ import annotations

import json
import sys

# 模块名与 pip 包名（部分模块名与包名不同，装依赖时需要包名）
REQUIRED = (
    ("cv2", "opencv-python"),
    ("numpy", "numpy"),
    ("PIL", "Pillow"),
)

MIN_VERSION = (3, 10)


def main() -> int:
    modules = {}
    missing = []
    for module_name, package_name in REQUIRED:
        try:
            module = __import__(module_name)
            modules[module_name] = str(getattr(module, "__version__", "unknown"))
        except Exception as exc:  # noqa: BLE001 - 任何导入失败都要回报给工作台
            missing.append(
                {
                    "module": module_name,
                    "package": package_name,
                    "error": f"{type(exc).__name__}: {exc}"[:300],
                }
            )

    version = ".".join(str(part) for part in sys.version_info[:3])
    supported = tuple(sys.version_info[:2]) >= MIN_VERSION
    if not supported:
        missing.append(
            {
                "module": "python",
                "package": "Python %d.%d+" % MIN_VERSION,
                "error": f"当前版本 {version} 过低",
            }
        )

    print(
        json.dumps(
            {
                "ok": not missing,
                "executable": sys.executable,
                "version": version,
                "supported": supported,
                "modules": modules,
                "missing": missing,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
