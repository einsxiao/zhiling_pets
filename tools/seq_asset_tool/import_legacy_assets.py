#!/usr/bin/env python3
"""import_legacy_assets.py — 把历史 2D 序列帧素材导入规范资产库。

背景：
  - 规范资产库位于仓库内 `assets/pet_seq`，是序列帧的唯一真源；
  - 历史 PNG 抽帧产物在 `assets/whale_gril/chibi_seq/frames/<action>`。

规则：
  1. 目标动作目录已有帧时整体跳过（不覆盖、不补插，避免破坏已调整的序列）；
  2. 空动作才从历史 PNG 转 WebP（默认 quality=82, method=4，速度与体积平衡）；
  3. 只新增文件，不删除任何素材；无历史素材的动作保持空目录并在清单中标记。

用法：
  python import_legacy_assets.py            # 为空动作补帧
  python import_legacy_assets.py --dry-run  # 只打印计划
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

from PIL import Image

TOOL_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(TOOL_DIR))
LIBRARY_ROOT = os.path.join(REPO_ROOT, 'assets', 'pet_seq')
MANIFEST_PATH = os.path.join(LIBRARY_ROOT, 'manifest.json')
LEGACY_ROOT = os.path.join(REPO_ROOT, 'assets', 'whale_gril', 'chibi_seq', 'frames')

DEFAULT_QUALITY = 82
DEFAULT_METHOD = 4


def log(message: str) -> None:
    print(message, flush=True)


def load_json(path: str):
    with open(path, 'r', encoding='utf-8') as handle:
        return json.load(handle)


def save_json(path: str, data) -> None:
    tmp = f'{path}.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='\n') as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
    os.replace(tmp, path)


def list_files(directory: str, suffix: str) -> list[str]:
    if not os.path.isdir(directory):
        return []
    return sorted(
        name for name in os.listdir(directory)
        if name.lower().endswith(suffix) and os.path.isfile(os.path.join(directory, name))
    )


def target_names_for(source_dir: str, suffix: str) -> list[str]:
    return [f'{os.path.splitext(name)[0]}.webp' for name in list_files(source_dir, suffix)]


def convert_missing_png_frames(
    source_dir: str,
    target_dir: str,
    quality: int,
    method: int,
) -> int:
    converted = 0
    os.makedirs(target_dir, exist_ok=True)
    for name in list_files(source_dir, '.png'):
        stem = os.path.splitext(name)[0]
        dst = os.path.join(target_dir, f'{stem}.webp')
        if os.path.exists(dst):
            continue
        with Image.open(os.path.join(source_dir, name)) as image:
            image.convert('RGBA').save(
                dst,
                'WEBP',
                quality=quality,
                method=method,
            )
        converted += 1
    return converted


def main() -> int:
    parser = argparse.ArgumentParser(description='补齐历史 2D 序列帧素材到 assets/pet_seq 资产库')
    parser.add_argument('--dry-run', action='store_true', help='只打印计划，不写文件')
    parser.add_argument('--quality', type=int, default=DEFAULT_QUALITY, help='WebP 质量（默认 82）')
    parser.add_argument('--method', type=int, default=DEFAULT_METHOD, help='WebP 编码方法 0-6（默认 4）')
    args = parser.parse_args()

    if not os.path.isfile(MANIFEST_PATH):
        log(f'缺少资产清单: {MANIFEST_PATH}')
        return 1

    manifest = load_json(MANIFEST_PATH)

    total_added = 0
    missing = []
    for avatar in manifest.get('avatars', []):
        avatar_id = avatar.get('id')
        if not avatar_id:
            continue
        log(f'形象 {avatar_id}:')
        for action in avatar.get('actions', []):
            action_id = action.get('id')
            if not action_id:
                continue
            target_dir = os.path.join(LIBRARY_ROOT, avatar_id, action_id)
            legacy_dir = os.path.join(LEGACY_ROOT, action_id)
            expected = target_names_for(legacy_dir, '.png')
            if not expected:
                log(f'  [{action_id}] 无素材，保持缺失')
                missing.append(action_id)
                continue

            existing = list_files(target_dir, '.webp')
            if existing:
                log(f'  [{action_id}] 已有 {len(existing)} 帧，跳过（不动已调整的序列）')
                continue
            if args.dry_run:
                log(f'  [{action_id}] 计划写入 {len(expected)} 帧')
                continue

            added = convert_missing_png_frames(legacy_dir, target_dir, args.quality, args.method)
            log(f'  [{action_id}] PNG → WebP {added} 帧（q={args.quality}, method={args.method}）')
            total_added += added

    if not args.dry_run:
        manifest['updatedAt'] = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        save_json(MANIFEST_PATH, manifest)

    log('---')
    log(f'新增 {total_added} 帧；缺失动作: {", ".join(missing) if missing else "无"}')
    log(f'资产库: {LIBRARY_ROOT}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
