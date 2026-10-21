"""资产库读写：manifest、WebP 编码、.trash 原子替换。"""
from __future__ import annotations

import json
import os
import re
import shutil
import time
from datetime import datetime, timezone

from PIL import Image

ID_RE = re.compile(r'^[a-z0-9][a-z0-9_-]{0,63}$', re.IGNORECASE)

ACTION_CONFIG_FILE = 'config.json'
LEGACY_TIMING_FILE = 'timing.json'
ACTION_CONFIG_SCHEMA_VERSION = 1
ACTION_META_KEYS = ('id', 'label', 'description', 'fps', 'loop', 'note')
TIMING_BASE_FPS = 12
# 知令运行时已接入的序列帧动作（其余为储备资产，仅入库与打包）
DEFAULT_RUNTIME_ACTIONS = ('idle', 'wave')
TIMING_MIN_MULTIPLIER = 0.1
TIMING_MAX_MULTIPLIER = 20


class LibraryError(RuntimeError):
    pass


def timestamp_label() -> str:
    now = datetime.now()
    return now.strftime('%Y-%m-%d-%H%M%S-') + f'{now.microsecond // 1000:03d}'


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def load_json(path: str, fallback=None):
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            return json.load(handle)
    except FileNotFoundError:
        if fallback is not None:
            return fallback
        raise


def save_json_atomic(path: str, data) -> None:
    tmp = f'{path}.{os.getpid()}.{int(time.time() * 1000)}.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='\n') as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
    os.replace(tmp, path)


def normalize_multiplier(value) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 1.0
    if number <= 0:
        return 1.0
    return round(min(TIMING_MAX_MULTIPLIER, max(TIMING_MIN_MULTIPLIER, number)), 3)


def frame_names(directory: str) -> list[str]:
    try:
        names = os.listdir(directory)
    except FileNotFoundError:
        return []
    return sorted(name for name in names if name.startswith('frame_') and name.endswith('.webp'))


def load_action_config(directory: str) -> dict:
    """读取动作目录 config.json；缺失时回退旧版 timing.json。

    返回对象至少可能是空 dict。`_sourceFile` 标记实际读取的文件名（诊断用）。
    """
    for name in (ACTION_CONFIG_FILE, LEGACY_TIMING_FILE):
        path = os.path.join(directory, name)
        try:
            data = load_json(path)
        except FileNotFoundError:
            continue
        if isinstance(data, dict):
            result = dict(data)
            result['_sourceFile'] = name
            return result
    return {}


def load_frame_multipliers(directory: str, count: int) -> list[float]:
    """读取动作目录 config.json 的逐帧倍数；缺项/缺文件 = 1，长度按 count 对齐。

    兼容旧版 timing.json（config.json 不存在时回退）。
    """
    data = load_action_config(directory)
    raw = data.get('frameMultipliers') if isinstance(data, dict) else None
    names = frame_names(directory)
    values: list = []
    if isinstance(raw, list):
        values = raw
    elif isinstance(raw, dict):
        values = [raw.get(name) for name in names]
    return [normalize_multiplier(values[index] if index < len(values) else None) for index in range(count)]


def action_meta_from_config(config: dict) -> dict:
    """从 config.json / 旧 timing.json 中提取动作元数据（不修改入参）。"""
    if not isinstance(config, dict):
        return {}
    meta = {}
    for key in ACTION_META_KEYS:
        if key in config:
            meta[key] = config.get(key)
    return meta


def write_action_config(directory: str, multipliers: list, meta: dict | None = None) -> None:
    """把逐帧时长与动作元数据写入动作目录 config.json。

    - `frameMultipliers` 只记录非 1 的覆盖项（键为 frame_XXX.webp）；
    - `meta` 为空时保留目录内已有 config.json 的元数据；
    - 不再写 timing.json（旧文件由迁移脚本/人工清理）。
    """
    existing = load_action_config(directory)
    source_meta = action_meta_from_config(existing)
    if meta:
        for key in ACTION_META_KEYS:
            if key in meta and meta[key] is not None:
                source_meta[key] = meta[key]

    overrides = {}
    for index, value in enumerate(multipliers):
        normalized = normalize_multiplier(value)
        if abs(normalized - 1.0) > 1e-9:
            overrides[f'frame_{index:03d}.webp'] = normalized

    payload = {'schemaVersion': ACTION_CONFIG_SCHEMA_VERSION}
    if source_meta.get('id'):
        payload['id'] = source_meta['id']
    if source_meta.get('label'):
        payload['label'] = source_meta['label']
    if source_meta.get('description') is not None:
        payload['description'] = source_meta.get('description') or ''
    if source_meta.get('fps') is not None:
        payload['fps'] = max(1, min(60, round(float(source_meta['fps']))))
    if source_meta.get('loop') is not None:
        payload['loop'] = bool(source_meta['loop'])
    if source_meta.get('note') is not None:
        payload['note'] = source_meta.get('note') or ''
    payload['baseFps'] = TIMING_BASE_FPS
    payload['frameMultipliers'] = overrides
    payload['updatedAt'] = iso_now()
    save_json_atomic(os.path.join(directory, ACTION_CONFIG_FILE), payload)


def resolve_library_root(explicit: str | None) -> str:
    if explicit:
        return os.path.abspath(explicit)
    tool_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    repo_root = os.path.dirname(os.path.dirname(tool_dir))
    return os.path.abspath(os.path.join(repo_root, 'assets', 'pet_seq'))


def load_manifest(library_root: str) -> dict:
    path = os.path.join(library_root, 'manifest.json')
    manifest = load_json(path)
    if not isinstance(manifest.get('avatars'), list):
        raise LibraryError(f'资产清单格式错误（缺少 avatars）：{path}')
    return manifest


def save_manifest(library_root: str, manifest: dict) -> None:
    manifest['updatedAt'] = iso_now()
    path = os.path.join(library_root, 'manifest.json')
    backup_dir = os.path.join(library_root, '.trash', 'manifest')
    os.makedirs(backup_dir, exist_ok=True)
    if os.path.isfile(path):
        shutil.copy2(path, os.path.join(backup_dir, f'{timestamp_label()}.json'))
    save_json_atomic(path, manifest)


def find_avatar(manifest: dict, avatar_id: str) -> dict:
    for avatar in manifest.get('avatars', []):
        if avatar.get('id') == avatar_id:
            return avatar
    raise LibraryError(f'资产清单中找不到形象：{avatar_id}')


def ensure_action(manifest: dict, avatar_id: str, action_id: str, *,
                  label: str | None = None, loop: bool | None = None,
                  fps: float | None = None, runtime_actions: list[str] | None = None,
                  note: str | None = None, description: str | None = None) -> dict:
    """新增或更新动作元数据，返回动作字典。

    description 是面向大模型/UI 的动作内容描述（可选，单行，≤200 码点），
    与 note（制作备注）分开维护；传 None 表示不修改已有值。
    """
    avatar = find_avatar(manifest, avatar_id)
    actions = avatar.setdefault('actions', [])
    action = next((item for item in actions if item.get('id') == action_id), None)
    runtime = action_id in (runtime_actions or [])
    if action is None:
        action = {
            'id': action_id,
            'label': (label or action_id)[:40],
            'description': (description or '')[:200],
            'loop': bool(loop) if loop is not None else action_id == 'idle',
            'fps': max(1, min(60, round(float(fps or 12)))),
            'runtime': runtime,
            'note': (note or '')[:240],
        }
        actions.append(action)
    else:
        if label:
            action['label'] = label[:40]
        if description is not None:
            action['description'] = description[:200]
        if loop is not None:
            action['loop'] = bool(loop)
        if fps is not None:
            action['fps'] = max(1, min(60, round(float(fps))))
        if note is not None:
            action['note'] = note[:240]
        action['runtime'] = runtime
    return action


def _swap_directory(target: str, staging: str, backup_root: str, label: str) -> str | None:
    backup = os.path.join(backup_root, timestamp_label(), label)
    os.makedirs(os.path.dirname(backup), exist_ok=True)
    moved_old = False
    try:
        if os.path.isdir(target):
            shutil.move(target, backup)
            moved_old = True
        elif os.path.exists(target):
            raise LibraryError(f'目标不是目录：{target}')
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.move(staging, target)
    except Exception:
        if moved_old and not os.path.exists(target):
            try:
                shutil.move(backup, target)
            except Exception:
                pass
        raise
    return backup if moved_old else None


def write_action_frames(library_root: str, avatar_id: str, action_id: str,
                        frames: list, *, quality: int = 82, method: int = 4,
                        dry_run: bool = False, preview_dir: str | None = None,
                        meta: dict | None = None) -> dict:
    """把 RGBA 帧编码为 WebP 并替换资产库动作目录。"""
    if not frames:
        raise LibraryError('没有可写入的帧')
    action_dir = os.path.join(library_root, avatar_id, action_id)
    # 帧数不变时保留逐帧时长倍数；重新生成改变了帧数则回到全 1。
    previous_count = len(frame_names(action_dir))
    multipliers = (load_frame_multipliers(action_dir, len(frames))
                   if previous_count == len(frames) else [1.0] * len(frames))
    if dry_run:
        out_dir = os.path.abspath(preview_dir or os.path.join(library_root, '.pipeline', 'preview', f'{timestamp_label()}-{action_id}'))
        os.makedirs(out_dir, exist_ok=True)
        for index, frame in enumerate(frames):
            Image.fromarray(frame).save(os.path.join(out_dir, f'frame_{index:03d}.png'))
        write_action_config(out_dir, multipliers, meta)
        return {'dryRun': True, 'preview': out_dir, 'frames': len(frames), 'backup': None}

    staging = os.path.join(library_root, '.staging', f'{timestamp_label()}-{avatar_id}-{action_id}')
    os.makedirs(staging, exist_ok=True)
    try:
        for index, frame in enumerate(frames):
            Image.fromarray(frame).save(
                os.path.join(staging, f'frame_{index:03d}.webp'),
                'WEBP', quality=int(quality), method=int(method),
            )
        write_action_config(staging, multipliers, meta)
        backup = _swap_directory(action_dir, staging, os.path.join(library_root, '.trash'),
                                 os.path.join(avatar_id, action_id))
    finally:
        if os.path.isdir(staging):
            shutil.rmtree(staging, ignore_errors=True)
    return {'dryRun': False, 'frames': len(frames), 'backup': backup, 'actionDir': action_dir}


def write_generation_log(library_root: str, avatar_id: str, action_id: str, data: dict) -> str:
    out_dir = os.path.join(library_root, '.pipeline')
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f'{timestamp_label()}-{avatar_id}-{action_id}.json')
    save_json_atomic(path, data)
    return path
