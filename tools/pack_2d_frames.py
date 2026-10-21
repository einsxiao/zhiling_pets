#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pack_2d_frames.py — 知令（ZHILING）2D 序列帧资产包 打包 / 校验工具

仅依赖 Python 3 标准库（os / sys / json / zipfile / argparse / re）。

校验口径与知令桌面端主进程导入器保持一致
（back_frame/src/pet_frame_import.js 与 pet_frame_registry.js 为真源）：
  - manifest：schemaVersion === 1、name 非空 ≤64 码点、actions 非空且必须含 idle；
    id/action.id/action.dir 匹配 ^[a-z0-9_-]{1,32}$；fps 1–60（缺省 defaultFps，再缺省 12）；
    loop 缺省 idle=true 其余 false；label ≤32 码点；description 可选单行文本 ≤200 码点（超长截断）；
    canvas [w,h] 有限正整数（可为空）；thumbnail 仅相对 png/webp 路径。
  - 帧文件：frame_%03d.%s（3–4 位序号，webp/png），同一动作扩展名与位宽一致，
    从 000 连续无缺号；单动作 ≤600 帧；idle ≥2 帧；形似 frame_* 但命名不合规 → 拒绝。
  - 动作目录 config.json（可选）：动作元数据（label/description/fps/loop/note）与
    frameMultipliers 同文件维护；frameMultipliers 支持对象键（按帧文件名）与数组（按帧序），
    0.1–20 倍、三位小数，缺省 1；非法/越界值会被导入器静默归一（工具给出警告）。
    旧版 timing.json 仍可读取（config.json 不存在时回退），新资产应使用 config.json。
  - 限额：zip ≤128MB、条目 ≤2000、单条目解压 ≤8MB、解压总量 ≤256MB。
  - 安全：条目名禁止空字节 / 反斜杠 / 盘符 / 绝对路径 / '..' / '.' / 空组件，
    拒绝 __MACOSX 与 .DS_Store；扩展名白名单 .json/.webp/.png/.md/.txt。
"""

import argparse
import json
import os
import re
import sys
import zipfile

# ---------------------------------------------------------------------------
# 常量（与 pet_frame_import.js / pet_frame_registry.js 同口径）
# ---------------------------------------------------------------------------

MAX_ZIP_BYTES = 128 * 1024 * 1024          # zip 文件大小上限（128MB）
MAX_TOTAL_BYTES = 256 * 1024 * 1024        # 解压后总字节上限（256MB）
MAX_ENTRY_BYTES = 8 * 1024 * 1024          # 单条目解压字节上限（8MB）
MAX_ENTRIES = 2000                         # zip/目录条目数上限
MAX_FRAMES_PER_ACTION = 600                # 单动作帧数上限

ALLOWED_EXTS = ('.json', '.webp', '.png', '.md', '.txt')
FRAME_FILE_RE = re.compile(r'^frame_(\d{3,4})\.(webp|png)$')
FRAME_LIKE_RE = re.compile(r'^frame_', re.IGNORECASE)
ID_RE = re.compile(r'^[a-z0-9_-]{1,32}$')

MULTIPLIER_MIN = 0.1
MULTIPLIER_MAX = 20.0

ACTION_CONFIG_FILE = 'config.json'
LEGACY_TIMING_FILE = 'timing.json'

# ---------------------------------------------------------------------------
# 报告收集
# ---------------------------------------------------------------------------


class Reporter:
    """错误 / 警告分级收集器。"""

    def __init__(self):
        self.errors = []
        self.warnings = []

    def error(self, msg):
        self.errors.append(msg)

    def warn(self, msg):
        self.warnings.append(msg)

    def merge(self, other):
        self.errors.extend(other.errors)
        self.warnings.extend(other.warnings)

    def is_ok(self):
        return not self.errors

    def print_summary(self, label):
        for e in self.errors:
            print('[错误] %s' % e)
        for w in self.warnings:
            print('[警告] %s' % w)
        if self.errors:
            print('=== %s：失败（%d 个错误，%d 个警告）===' % (label, len(self.errors), len(self.warnings)))
        else:
            print('=== %s：通过（0 个错误，%d 个警告）===' % (label, len(self.warnings)))


# ---------------------------------------------------------------------------
# 与导入器同口径的校验函数
# ---------------------------------------------------------------------------

def _is_object(value):
    return isinstance(value, dict)


def _normalize_fps(value, fallback):
    """帧率归一：1–60 取整，否则回退 fallback（与 _normalizeFps 同口径）。"""
    try:
        n = float(value)
    except (TypeError, ValueError):
        return fallback
    if not _is_finite(n):
        return fallback
    rounded = round(n)
    return rounded if 1 <= rounded <= 60 else fallback


def _is_finite(n):
    try:
        return n == n and n not in (float('inf'), float('-inf'))
    except TypeError:
        return False


def _finite_positive_int(value):
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if not _is_finite(n) or n <= 0:
        return None
    return int(round(n))


def normalize_seq_multiplier(value):
    """时长倍数规整：非法/缺失 → 1；范围 0.1–20；保留三位小数（与 normalizeSeqMultiplier 同口径）。"""
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 1.0
    if not _is_finite(n) or n <= 0:
        return 1.0
    return round(min(MULTIPLIER_MAX, max(MULTIPLIER_MIN, n)) * 1000) / 1000


def validate_manifest(manifest, reporter):
    """校验并归一化 manifest（与 validateFrameManifest 同口径）。
    返回归一化对象；校验失败返回 None（错误已入 reporter）。
    """
    if not _is_object(manifest):
        reporter.error('invalid_manifest：manifest 不是 JSON 对象')
        return None
    if manifest.get('schemaVersion') != 1:
        reporter.error('invalid_manifest：schemaVersion 必须为 1')
        return None

    name = manifest.get('name')
    name = name.strip() if isinstance(name, str) else ''
    if not name:
        reporter.error('invalid_manifest：manifest.name 缺失或为空')
        return None
    if len(name) > 64:
        reporter.error('invalid_manifest：manifest.name 超过 64 码点')
        return None

    if not isinstance(manifest.get('actions'), list):
        reporter.error('invalid_manifest：manifest.actions 缺失或不是数组')
        return None

    mid = manifest.get('id')
    if mid is not None:
        if not isinstance(mid, str) or not mid.strip() or not ID_RE.match(mid.strip()):
            reporter.error("invalid_manifest：manifest.id（'%s'）不符合 ^[a-z0-9_-]{1,32}$" % mid)
            return None

    raw_default = manifest.get('defaultFps')
    default_fps = _normalize_fps(raw_default, 12)
    if raw_default is not None:
        try:
            fv = float(raw_default)
        except (TypeError, ValueError):
            reporter.warn('manifest.defaultFps（%s）非法，将回退为 %d' % (raw_default, default_fps))
        else:
            if fv != default_fps:
                reporter.warn('manifest.defaultFps（%s）将被归一化为 %d（1–60 取整）' % (raw_default, default_fps))

    actions = []
    seen_ids = set()
    for raw in manifest['actions']:
        if not _is_object(raw):
            reporter.error('invalid_actions：action 不是对象')
            return None
        action_id = raw.get('id')
        action_id = action_id.strip() if isinstance(action_id, str) else ''
        if not ID_RE.match(action_id):
            reporter.error("invalid_actions：action.id（'%s'）不符合白名单" % action_id)
            return None
        if action_id in seen_ids:
            reporter.error("invalid_actions：action.id 重复：'%s'" % action_id)
            return None
        seen_ids.add(action_id)

        action_dir = action_id
        raw_dir = raw.get('dir')
        if isinstance(raw_dir, str) and raw_dir.strip():
            action_dir = raw_dir.strip()
            if not ID_RE.match(action_dir):
                reporter.error("invalid_actions：action.dir（'%s'）不符合白名单" % action_dir)
                return None

        raw_fps = raw.get('fps')
        if raw_fps is not None:
            fps = _normalize_fps(raw_fps, default_fps)
            try:
                if float(raw_fps) != fps:
                    reporter.warn("动作 '%s' 的 fps（%s）将被归一化为 %d" % (action_id, raw_fps, fps))
            except (TypeError, ValueError):
                reporter.warn("动作 '%s' 的 fps（%s）非法，将回退为 %d" % (action_id, raw_fps, fps))
        else:
            fps = default_fps

        loop = raw.get('loop') if isinstance(raw.get('loop'), bool) else (action_id == 'idle')

        label = raw.get('label')
        if label is None:
            label = ''
        elif not isinstance(label, str):
            label = str(label)
        label = label.strip()[:32]
        if isinstance(raw.get('label'), str) and len(raw['label'].strip()) > 32:
            reporter.warn("动作 '%s' 的 label 超过 32 码点，将被截断" % action_id)

        # description：面向大模型/UI 的动作内容描述（可选，单行，≤200 码点）
        raw_description = raw.get('description')
        if raw_description is None:
            description = ''
        elif isinstance(raw_description, str):
            description = ' '.join(raw_description.split())
        else:
            description = str(raw_description).strip()
            reporter.warn("动作 '%s' 的 description 不是字符串，将被转为文本" % action_id)
        if len(description) > 200:
            reporter.warn("动作 '%s' 的 description 超过 200 码点，将被截断" % action_id)
            description = description[:200]

        actions.append({
            'id': action_id,
            'label': label,
            'description': description,
            'dir': action_dir,
            'fps': fps,
            'loop': loop,
        })

    if not any(a['id'] == 'idle' for a in actions):
        reporter.error('missing_idle：actions 缺少必需的 idle 动作')
        return None

    # canvas：[w, h] 有限正整数取整；否则 null
    canvas = None
    raw_canvas = manifest.get('canvas')
    if isinstance(raw_canvas, list) and len(raw_canvas) == 2:
        w = _finite_positive_int(raw_canvas[0])
        h = _finite_positive_int(raw_canvas[1])
        if w is not None and h is not None:
            canvas = [w, h]
    if raw_canvas is not None and canvas is None:
        reporter.warn('manifest.canvas 非法（需 [宽, 高] 正整数），将被置为 null')

    # thumbnail：相对路径、png/webp、无 .. / 绝对路径 / 盘符 / 空组件
    thumbnail = None
    raw_thumb = manifest.get('thumbnail')
    if isinstance(raw_thumb, str) and raw_thumb.strip():
        s = raw_thumb.strip()
        parts = [p for p in s.replace('\\', '/').split('/') if p != '.']
        ok = (not re.match(r'^[a-zA-Z]:', s)
              and not s.startswith('/')
              and len(parts) > 0
              and all(p and p != '..' for p in parts)
              and os.path.splitext(parts[-1])[1].lower() in ('.png', '.webp'))
        if ok:
            thumbnail = '/'.join(parts)
        else:
            reporter.warn("manifest.thumbnail（'%s'）非法（仅相对 png/webp 路径），将被置为 null" % s)

    license_obj = manifest.get('license')
    if license_obj is None:
        license_obj = {}
    elif not _is_object(license_obj):
        reporter.warn('manifest.license 非对象，将被置为 {}')
        license_obj = {}
    license_obj = dict(license_obj)

    origin = manifest.get('origin')
    if origin is None:
        origin = {}
    elif not _is_object(origin):
        reporter.warn('manifest.origin 非对象，将被置为 {}')
        origin = {}
    origin = dict(origin)

    created_at = manifest.get('createdAt')
    if created_at is None:
        created_at = ''
    elif not isinstance(created_at, str):
        reporter.warn('manifest.createdAt 非字符串，将被置为空')
        created_at = ''
    created_at = created_at.strip()

    return {
        'schemaVersion': 1,
        'id': mid.strip() if isinstance(mid, str) and mid.strip() else '',
        'name': name,
        'canvas': canvas,
        'defaultFps': default_fps,
        'thumbnail': thumbnail,
        'license': license_obj,
        'origin': origin,
        'createdAt': created_at,
        'actions': actions,
    }


def validate_action_frames(file_names, min_frames, max_frames, reporter):
    """校验单个动作目录的帧文件名集合（与 validateActionFrames 同口径）。
    返回 (sorted_names, frames_count, ext, naming)；失败返回 None。
    """
    frames = []
    for name in file_names:
        m = FRAME_FILE_RE.match(name)
        if m:
            frames.append({'num': int(m.group(1)), 'width': len(m.group(1)), 'ext': m.group(2), 'name': name})
        elif FRAME_LIKE_RE.match(name):
            reporter.error("invalid_frames：帧文件名不合规（形似 frame_* 但命名非法）：%s" % name)
            return None
        # 其余文件（timing.json、README.md 等）不参与帧校验
    if len(frames) < min_frames:
        reporter.error('invalid_frames：帧数不足（%d < %d）' % (len(frames), min_frames))
        return None
    if len(frames) > max_frames:
        reporter.error('invalid_frames：帧数超限（%d > %d）' % (len(frames), max_frames))
        return None
    exts = {f['ext'] for f in frames}
    if len(exts) > 1:
        reporter.error('invalid_frames：同一动作内帧扩展名必须一致（%s）' % '/'.join(sorted(exts)))
        return None
    widths = {f['width'] for f in frames}
    if len(widths) > 1:
        reporter.error('invalid_frames：同一动作内帧序号位宽必须一致')
        return None
    frames.sort(key=lambda f: f['num'])
    for i, f in enumerate(frames):
        if f['num'] != i:
            reporter.error('invalid_frames：帧序号必须从 000 连续无缺号（第 %d 位期望 %03d，实际 %s）'
                           % (i, i, f['name']))
            return None
    ext = frames[0]['ext']
    width = frames[0]['width']
    return [f['name'] for f in frames], len(frames), ext, 'frame_%0{}d.{}'.format(width, ext)


def normalize_action_multipliers(raw, frame_names, reporter, action_label):
    """timing.json 的 frameMultipliers 归一（与 normalizeActionMultipliers 同口径）。
    支持对象键与数组；非法输入 → 全 1；越界值 → 归一并警告。
    """
    count = len(frame_names)
    result = [1.0] * count
    if count == 0:
        return result
    if isinstance(raw, list):
        for i in range(count):
            if i < len(raw) and raw[i] != 1:
                result[i] = normalize_seq_multiplier(raw[i])
                if result[i] != raw[i]:
                    reporter.warn("动作 '%s' timing.json 第 %d 帧倍数 %s 越界/非法，已归一为 %s"
                                  % (action_label, i, raw[i], result[i]))
    elif _is_object(raw):
        for i, name in enumerate(frame_names):
            if name in raw and raw[name] != 1:
                result[i] = normalize_seq_multiplier(raw[name])
                if result[i] != raw[name]:
                    reporter.warn("动作 '%s' timing.json 帧 %s 倍数 %s 越界/非法，已归一为 %s"
                                  % (action_label, name, raw[name], result[i]))
    else:
        if raw is not None:
            reporter.warn("动作 '%s' timing.json 的 frameMultipliers 非对象/数组，将按全 1 处理" % action_label)
    return result


def load_action_config(action_dir, frame_names, reporter, action_id):
    """读取动作目录 config.json（缺失时回退 timing.json）并归一逐帧倍数。

    返回 (multipliers, config_path_or_None, file_name_or_None)。config.json 优先；
    旧 timing.json 会给出迁移警告，但仍按原值校验。
    """
    for file_name, legacy in ((ACTION_CONFIG_FILE, False), (LEGACY_TIMING_FILE, True)):
        path = os.path.join(action_dir, file_name)
        if not os.path.isfile(path):
            if os.path.exists(path):
                reporter.warn("动作 '%s' 的 %s 不是普通文件，将被忽略" % (action_id, file_name))
            continue
        try:
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except (OSError, ValueError) as e:
            reporter.warn("动作 '%s' 的 %s 读取失败，将被忽略（%s）" % (action_id, file_name, e))
            return [1.0] * len(frame_names), None, None
        if not _is_object(data):
            reporter.warn("动作 '%s' 的 %s 不是 JSON 对象，将被忽略（全 1 倍）" % (action_id, file_name))
            return [1.0] * len(frame_names), None, None
        if legacy:
            reporter.warn("动作 '%s' 仍在使用旧版 timing.json，建议迁移到 config.json" % action_id)
        return normalize_action_multipliers(data.get('frameMultipliers'), frame_names, reporter, action_id), path, file_name
    return [1.0] * len(frame_names), None, None


def load_action_config_from_zip(zf, action_prefix, frame_names, entry_names, reporter, action_id):
    """从 zip 动作目录读取 config.json（缺失时回退 timing.json）并归一逐帧倍数。"""
    for file_name, legacy in ((ACTION_CONFIG_FILE, False), (LEGACY_TIMING_FILE, True)):
        entry_name = action_prefix + file_name
        if entry_name not in entry_names:
            continue
        try:
            data = json.loads(zf.read(entry_name).decode('utf-8'))
        except (KeyError, ValueError, OSError):
            reporter.warn("动作 '%s' 的 %s 解析失败，将被忽略" % (action_id, file_name))
            return [1.0] * len(frame_names)
        if not _is_object(data):
            reporter.warn("动作 '%s' 的 %s 不是 JSON 对象，将被忽略（全 1 倍）" % (action_id, file_name))
            return [1.0] * len(frame_names)
        if legacy:
            reporter.warn("动作 '%s' 仍在使用旧版 timing.json，建议迁移到 config.json" % action_id)
        return normalize_action_multipliers(data.get('frameMultipliers'), frame_names, reporter, action_id)
    return [1.0] * len(frame_names)


# ---------------------------------------------------------------------------
# zip 条目安全检查（与 _checkEntryName 同口径）
# ---------------------------------------------------------------------------

def check_entry_name(name):
    """条目名安全校验（zip-slip 防护）。返回 None 表示安全，否则返回拒绝原因。"""
    if not name:
        return '空条目名'
    if '\x00' in name:
        return '条目名含空字节：%s' % name
    if '\\' in name:
        return '条目名含反斜杠：%s' % name
    if re.match(r'^[a-zA-Z]:', name):
        return '条目名含盘符：%s' % name
    if name.startswith('/'):
        return '条目名是绝对路径：%s' % name
    parts = name.split('/')
    for p in parts:
        if not p:
            return '条目名含空组件：%s' % name
        if p == '..':
            return "条目名含 '..'：%s" % name
        if p == '.':
            return "条目名含 '.' 组件：%s" % name
        if p == '.DS_Store':
            return '拒绝 .DS_Store：%s' % name
        if p.startswith('__MACOSX'):
            return '拒绝 __MACOSX：%s' % name
    return None


def _is_allowed_entry_name(name):
    return os.path.splitext(name)[1].lower() in ALLOWED_EXTS


# ---------------------------------------------------------------------------
# manifest 定位（目录来源：自身 manifest 或父目录 avatars[] 库条目合成）
# ---------------------------------------------------------------------------

def _synthesize_manifest_from_avatar(avatar, dir_path):
    """用 pet_seq 库级 manifest 的 avatars[] 条目合成单形象包 manifest。
    仅保留目录中实际存在对应动作目录的条目（与 _synthesizeManifestFromAvatar 同口径）。
    """
    actions = []
    for raw in avatar.get('actions') or []:
        if not _is_object(raw) or not isinstance(raw.get('id'), str) or not raw['id']:
            continue
        action_dir = raw['dir'].strip() if isinstance(raw.get('dir'), str) and raw['dir'].strip() else raw['id']
        full = os.path.join(dir_path, action_dir)
        if not (os.path.isdir(full) and not os.path.islink(full)):
            continue
        actions.append({
            'id': raw['id'],
            'label': raw.get('label'),
            'description': raw.get('description'),
            'dir': action_dir,
            'fps': raw.get('fps'),
            'loop': raw.get('loop'),
        })
    result = {
        'schemaVersion': 1,
        'kind': '2d_frames',
        'name': avatar['name'] if isinstance(avatar.get('name'), str) and avatar['name'].strip() else os.path.basename(dir_path),
        'canvas': avatar.get('canvas'),
        'defaultFps': avatar.get('defaultFps'),
        'thumbnail': avatar.get('thumbnail'),
        'license': avatar.get('license') if _is_object(avatar.get('license')) else {},
        'origin': avatar.get('origin') if _is_object(avatar.get('origin')) else {},
        'actions': actions,
    }
    # 库条目 id（如 whale_chibi）作为可选 manifest.id 带入包内，
    # 便于导入时生成稳定的 user_2d_<id> 目录名（白名单字段，符合规范）
    if isinstance(avatar.get('id'), str) and ID_RE.match(avatar['id'].strip()):
        result['id'] = avatar['id'].strip()
    return result


def load_manifest_for_dir(dir_path, reporter):
    """读取目录对应的包 manifest：目录自身 manifest.json，或父目录库级 manifest 的
    avatars[] 中 id 与目录名匹配的条目合成；均无 → None（并记 missing_manifest）。
    """
    self_path = os.path.join(dir_path, 'manifest.json')
    if os.path.isfile(self_path):
        try:
            with open(self_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (OSError, ValueError) as e:
            reporter.error('invalid_manifest：manifest.json 读取失败（%s）' % e)
            return None
    parent = os.path.dirname(dir_path)
    lib_path = os.path.join(parent, 'manifest.json')
    if os.path.isfile(lib_path):
        try:
            with open(lib_path, 'r', encoding='utf-8') as f:
                lib = json.load(f)
            if _is_object(lib) and isinstance(lib.get('avatars'), list):
                for avatar in lib['avatars']:
                    if _is_object(avatar) and avatar.get('id') == os.path.basename(dir_path):
                        return _synthesize_manifest_from_avatar(avatar, dir_path)
        except (OSError, ValueError):
            pass
    reporter.error("missing_manifest：目录自身及父目录（avatars[] 条目）均未找到 '%s' 的 manifest" % os.path.basename(dir_path))
    return None


# ---------------------------------------------------------------------------
# 目录校验
# ---------------------------------------------------------------------------

def _list_dir_file_names(dir_path):
    """目录内普通文件 basename 列表（排除 symlink 与子目录；与 _listActionFileNames 同口径）。"""
    if not os.path.isdir(dir_path) or os.path.islink(dir_path):
        return []
    names = []
    try:
        entries = os.scandir(dir_path)
    except OSError:
        return []
    with entries:
        for entry in entries:
            try:
                if entry.is_symlink() or entry.is_dir():
                    continue
                if entry.is_file():
                    names.append(entry.name)
            except OSError:
                continue
    return names


def validate_dir(dir_path, reporter):
    """校验一个 2D 序列帧包目录（含 pet_seq 库结构：无自身 manifest 时读父目录 avatars[]）。
    错误 → exit 1 口径；警告不影响退出码。
    """
    dir_path = os.path.abspath(dir_path)
    if not os.path.isdir(dir_path):
        reporter.error('file_not_found：目录不存在：%s' % dir_path)
        return

    manifest = load_manifest_for_dir(dir_path, reporter)
    if manifest is None:
        return
    norm = validate_manifest(manifest, reporter)
    if norm is None:
        return

    # 动作帧校验 + 动作配置归一（config.json 优先，旧 timing.json 回退）
    for action in norm['actions']:
        action_dir = os.path.join(dir_path, action['dir'])
        names = _list_dir_file_names(action_dir)
        r = validate_action_frames(names, 2 if action['id'] == 'idle' else 1, MAX_FRAMES_PER_ACTION, reporter)
        if r is None:
            reporter.error("动作 '%s' 帧校验失败（目录 %s）" % (action['id'], action['dir']))
            continue
        sorted_names = r[0]
        load_action_config(action_dir, sorted_names, reporter, action['id'])

    # 限额预检：文件数 / 单文件 / 总量（与目录导入同口径）
    file_count = 0
    total_bytes = 0
    for root, dirs, files in os.walk(dir_path):
        # 不跟随目录 symlink（与导入器同口径）
        dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(root, d))]
        for name in files:
            full = os.path.join(root, name)
            try:
                if os.path.islink(full):
                    continue
                rel = os.path.relpath(full, dir_path).replace(os.sep, '/')
                size = os.path.getsize(full)
            except OSError:
                continue
            if rel == 'manifest.json':
                continue
            if not _is_allowed_entry_name(name):
                reporter.warn("文件 '%s' 不在扩展名白名单内（目录导入会跳过；打进 zip 会直接拒绝）" % rel)
                continue
            file_count += 1
            if size > MAX_ENTRY_BYTES:
                reporter.error('file_too_large：文件超过单文件上限（8MB）：%s' % rel)
            total_bytes += size
    if file_count > MAX_ENTRIES:
        reporter.error('too_many_entries：文件数 %d 超过上限 %d' % (file_count, MAX_ENTRIES))
    if total_bytes > MAX_TOTAL_BYTES:
        reporter.error('file_too_large：总字节 %d 超过上限 %d（256MB）' % (total_bytes, MAX_TOTAL_BYTES))

    # thumbnail 文件存在性
    if norm['thumbnail']:
        thumb_path = os.path.join(dir_path, *norm['thumbnail'].split('/'))
        if not os.path.isfile(thumb_path):
            reporter.warn("manifest.thumbnail（'%s'）指向的文件不存在，导入后将回退 idle 首帧" % norm['thumbnail'])


# ---------------------------------------------------------------------------
# zip 校验
# ---------------------------------------------------------------------------

def _locate_manifest_in_zip(names):
    """在文件条目列表中定位 manifest：根 manifest.json 或单层包裹目录自动下钻。"""
    if 'manifest.json' in names:
        return 'manifest.json', ''
    tops = {n.split('/')[0] for n in names}
    if len(tops) == 1:
        top = tops.pop()
        if top != 'manifest.json' and ('%s/manifest.json' % top) in names:
            return '%s/manifest.json' % top, top + '/'
    return None, None


def validate_zip(zip_path, reporter):
    """校验一个 2D 序列帧 zip 包（限额 / 安全 / manifest / 帧集合，与导入器同口径）。"""
    if not os.path.isfile(zip_path):
        reporter.error('file_not_found：zip 不存在：%s' % zip_path)
        return
    try:
        size = os.path.getsize(zip_path)
    except OSError as e:
        reporter.error('read_failed：无法读取 zip（%s）' % e)
        return
    if size > MAX_ZIP_BYTES:
        reporter.error('file_too_large：zip 大小 %d 超过 128MB 上限' % size)
        return

    try:
        zf = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile as e:
        reporter.error('read_failed：zip 损坏或不是 zip 文件（%s）' % e)
        return

    with zf:
        entries = []
        total_bytes = 0
        count = 0
        for info in zf.infolist():
            count += 1
            if count > MAX_ENTRIES:
                reporter.error('too_many_entries：条目数超过上限 %d' % MAX_ENTRIES)
                return
            name = info.filename
            clean = re.sub(r'/+$', '', name)
            if clean and clean != '/':
                err = check_entry_name(clean)
                if err:
                    reporter.error('unsafe_entry：%s' % err)
                    return
            if info.is_dir() or name.endswith('/') or not clean:
                continue  # 目录条目跳过（但参与计数与安全检查）
            if not _is_allowed_entry_name(clean):
                reporter.error('unsafe_entry：不允许的文件类型：%s' % clean)
                return
            if info.file_size > MAX_ENTRY_BYTES:
                reporter.error('file_too_large：条目超过单文件上限（8MB）：%s' % clean)
                return
            total_bytes += info.file_size
            if total_bytes > MAX_TOTAL_BYTES:
                reporter.error('file_too_large：解压总字节超过上限（256MB）')
                return
            entries.append(clean)

        names = set(entries)
        manifest_name, prefix = _locate_manifest_in_zip(names)
        if manifest_name is None:
            reporter.error('missing_manifest：未找到 manifest.json（根或单层包裹目录）')
            return

        try:
            parsed = json.loads(zf.read(manifest_name).decode('utf-8'))
        except (KeyError, ValueError, OSError) as e:
            reporter.error('invalid_manifest：manifest.json 解析失败（%s）' % e)
            return
        norm = validate_manifest(parsed, reporter)
        if norm is None:
            return

        for action in norm['actions']:
            action_prefix = '%s%s/' % (prefix, action['dir'])
            act_names = []
            for n in entries:
                if n.startswith(action_prefix):
                    rel = n[len(action_prefix):]
                    if rel and '/' not in rel:
                        act_names.append(rel)
            r = validate_action_frames(act_names, 2 if action['id'] == 'idle' else 1, MAX_FRAMES_PER_ACTION, reporter)
            if r is None:
                reporter.error("动作 '%s' 帧校验失败" % action['id'])
                continue
            sorted_names = r[0]
            load_action_config_from_zip(zf, action_prefix, sorted_names, names, reporter, action['id'])

        if norm['thumbnail']:
            thumb_name = '%s%s' % (prefix, norm['thumbnail'])
            if thumb_name not in names:
                reporter.warn("manifest.thumbnail（'%s'）不在包内，导入后将回退 idle 首帧" % norm['thumbnail'])


# ---------------------------------------------------------------------------
# 打包
# ---------------------------------------------------------------------------

def _collect_dir_files(dir_path, root_path=None):
    """递归收集目录下可打包文件（跳过 symlink、跳过非白名单扩展）。
    返回 [(abs_path, rel_with_slash)]。
    """
    if root_path is None:
        root_path = dir_path
    out = []
    try:
        entries = sorted(os.scandir(dir_path), key=lambda e: e.name)
    except OSError:
        return out
    for entry in entries:
        try:
            if entry.is_symlink():
                continue
            if entry.is_dir():
                out.extend(_collect_dir_files(entry.path, root_path))
            elif entry.is_file():
                rel = os.path.relpath(entry.path, root_path).replace(os.sep, '/')
                if _is_allowed_entry_name(entry.name):
                    out.append((entry.path, rel))
        except OSError:
            continue
    return out


def _is_junk_rel(rel):
    """是否应拒绝写入的系统垃圾条目（__MACOSX / .DS_Store / Thumbs.db，任意层级）。"""
    for p in rel.split('/'):
        if p.startswith('__MACOSX') or p == '.DS_Store' or p.lower() == 'thumbs.db':
            return True
    return False


def build_normalized_manifest(norm, selected_actions, thumbnail):
    """组装打包用归一化 manifest（作者字段原样 + 动作过滤 + 缩略图覆盖）。"""
    out = {
        'schemaVersion': 1,
        'kind': '2d_frames',
        'name': norm['name'],
        'canvas': norm['canvas'],
        'defaultFps': norm['defaultFps'],
        'thumbnail': thumbnail if thumbnail is not None else norm['thumbnail'],
        'license': dict(norm.get('license') or {}),
        'origin': dict(norm.get('origin') or {}),
        'actions': [dict(a) for a in norm['actions'] if a['id'] in selected_actions],
    }
    if norm.get('id'):
        out['id'] = norm['id']
    if norm.get('createdAt'):
        out['createdAt'] = norm['createdAt']
    return out


def pack_dir(dir_path, out_path, actions_filter, thumb_path, reporter):
    """把目录内容打包为 zip（条目路径统一 '/'，拒绝 __MACOSX/.DS_Store/Thumbs.db）。"""
    dir_path = os.path.abspath(dir_path)
    if not os.path.isdir(dir_path):
        reporter.error('file_not_found：目录不存在：%s' % dir_path)
        return False

    manifest = load_manifest_for_dir(dir_path, reporter)
    if manifest is None:
        return False
    norm = validate_manifest(manifest, reporter)
    if norm is None:
        return False

    # 动作选择
    all_ids = [a['id'] for a in norm['actions']]
    if actions_filter:
        wanted = []
        for token in actions_filter.split(','):
            token = token.strip()
            if token and token not in wanted:
                wanted.append(token)
        missing = [w for w in wanted if w not in all_ids]
        if missing:
            reporter.error('invalid_payload：--actions 指定的动作不存在于 manifest：%s' % ', '.join(missing))
            return False
        selected = set(wanted)
    else:
        selected = set(all_ids)

    # 先对所选动作做帧校验（失败则不打）
    action_files = {}  # action_id -> {rel: abs}
    for action in norm['actions']:
        if action['id'] not in selected:
            continue
        action_dir = os.path.join(dir_path, action['dir'])
        names = _list_dir_file_names(action_dir)
        r = validate_action_frames(names, 2 if action['id'] == 'idle' else 1, MAX_FRAMES_PER_ACTION, reporter)
        if r is None:
            reporter.error("动作 '%s' 帧校验失败，拒绝打包" % action['id'])
            return False
        sorted_names = r[0]
        files = {}
        for name in sorted_names:
            files['%s/%s' % (action['dir'], name)] = os.path.join(action_dir, name)
        _multipliers, config_path, config_name = load_action_config(
            action_dir, sorted_names, reporter, action['id'])
        if config_path:
            files['%s/%s' % (action['dir'], config_name)] = config_path
        action_files[action['id']] = files

    # 收集其余可打包文件（排除所有 manifest 动作目录与 manifest.json / thumb 特例）
    all_action_dirs = {a['dir'] for a in norm['actions']}
    other_files = {}
    for abs_path, rel in _collect_dir_files(dir_path):
        top = rel.split('/')[0]
        if top in all_action_dirs or rel == 'manifest.json':
            continue
        if top == 'base':
            continue  # 基础帧/原画只作作者侧参考，不进入运行时资产包
        if top in ('thumb.png', 'thumb.webp'):
            continue  # 缩略图单独处理
        if _is_junk_rel(rel):
            reporter.warn('拒绝写入系统垃圾文件：%s' % rel)
            continue
        other_files[rel] = abs_path

    # 缩略图：--thumb 覆盖 > 目录自带 thumb.png/webp
    thumb_entry = None
    thumb_source = None
    if thumb_path:
        if not os.path.isfile(thumb_path):
            reporter.error('file_not_found：--thumb 指定的文件不存在：%s' % thumb_path)
            return False
        ext = os.path.splitext(thumb_path)[1].lower()
        if ext not in ('.png', '.webp'):
            reporter.error('invalid_payload：--thumb 仅支持 png/webp 图片（%s）' % thumb_path)
            return False
        thumb_entry = 'thumb.' + ext[1:]
        thumb_source = thumb_path
    else:
        for cand in ('thumb.png', 'thumb.webp'):
            p = os.path.join(dir_path, cand)
            if os.path.isfile(p):
                thumb_entry = cand
                thumb_source = p
                break

    final_manifest = build_normalized_manifest(norm, selected, thumb_entry)

    # 限额预检
    total_bytes = 0
    all_entries = {}  # rel -> abs
    for files in action_files.values():
        all_entries.update(files)
    all_entries.update(other_files)
    if thumb_entry and thumb_source:
        all_entries[thumb_entry] = thumb_source
    if len(all_entries) + 1 > MAX_ENTRIES:  # +1 = manifest.json
        reporter.error('too_many_entries：条目数 %d 超过上限 %d' % (len(all_entries) + 1, MAX_ENTRIES))
        return False
    for rel, abs_path in all_entries.items():
        try:
            size = os.path.getsize(abs_path)
        except OSError as e:
            reporter.error('read_failed：读取失败 %s（%s）' % (rel, e))
            return False
        if size > MAX_ENTRY_BYTES:
            reporter.error('file_too_large：文件超过单文件上限（8MB）：%s' % rel)
            return False
        total_bytes += size
    if total_bytes > MAX_TOTAL_BYTES:
        reporter.error('file_too_large：总字节 %d 超过上限（256MB）' % total_bytes)
        return False

    # 写 zip
    out_dir = os.path.dirname(os.path.abspath(out_path))
    if not os.path.isdir(out_dir):
        reporter.error('write_failed：输出目录不存在：%s' % out_dir)
        return False
    try:
        with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            zf.writestr('manifest.json', json.dumps(final_manifest, ensure_ascii=False, indent=2))
            for rel in sorted(all_entries):
                zf.write(all_entries[rel], rel)
    except OSError as e:
        reporter.error('write_failed：写入 zip 失败（%s）' % e)
        return False

    # 打包后自检
    print('已生成：%s' % out_path)
    try:
        print('  zip 大小：%d 字节' % os.path.getsize(out_path))
    except OSError:
        pass
    print('  动作：%s' % ', '.join(sorted(selected)))
    for action in norm['actions']:
        if action['id'] in selected:
            n = sum(1 for k in action_files.get(action['id'], {})
                    if FRAME_FILE_RE.match(k.rsplit('/', 1)[-1]))
            print('  %s：%d 帧' % (action['id'], n))
    check = Reporter()
    validate_zip(out_path, check)
    if not check.is_ok():
        reporter.error('打包产物自检失败：%s' % '；'.join(check.errors))
        return False
    reporter.merge(check)  # 附上自检警告
    return True


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_arg_parser():
    parser = argparse.ArgumentParser(
        prog='pack_2d_frames.py',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description='知令（ZHILING）2D 序列帧资产包 打包 / 校验工具（Python 3 标准库，无第三方依赖）。\n'
                    '校验口径与知令桌面端导入器 pet_frame_import.js / pet_frame_registry.js 保持一致。',
        epilog='''示例：
  # 校验一个资产包目录（无自身 manifest 时自动读父目录 avatars[] 库条目）
  python tools/pack_2d_frames.py --validate assets/pet_seq/whale_chibi

  # 校验一个已打好的 zip 包
  python tools/pack_2d_frames.py --validate examples/whale_chibi_demo.zip

  # 把目录内容打包为 zip（目录本身不进入 zip）
  python tools/pack_2d_frames.py --pack assets/pet_seq/whale_chibi --out examples/whale_chibi_demo.zip

  # 只打包 idle 与 wave 两个动作
  python tools/pack_2d_frames.py --pack assets/pet_seq/whale_chibi --actions idle,wave --out demo.zip

  # 打包并覆盖包内 thumb.png
  python tools/pack_2d_frames.py --pack my_avatar --out demo.zip --thumb thumbnails/preview.png

退出码：0 = 校验通过 / 打包成功；1 = 存在错误（校验失败 / 打包失败）；2 = 参数错误。
''')
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--validate', metavar='<目录|zip>',
                       help='校验 2D 序列帧包（目录或 zip），输出错误/警告分级问题列表')
    group.add_argument('--pack', metavar='<目录>',
                       help='把目录内容（不是目录本身）打包为 2D 序列帧 zip')
    parser.add_argument('--out', metavar='<zip>', help='--pack 的输出 zip 路径')
    parser.add_argument('--actions', metavar='idle,wave',
                        help='只打包清单中的动作（逗号分隔，缺省全部动作；仅配合 --pack）')
    parser.add_argument('--thumb', metavar='<图片>', help='覆盖包内 thumb.png / thumb.webp（png 或 webp）')
    return parser


def main(argv=None):
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    reporter = Reporter()
    if args.validate:
        target = args.validate
        if zipfile.is_zipfile(target):
            validate_zip(target, reporter)
        elif os.path.isdir(target):
            validate_dir(target, reporter)
        else:
            validate_zip(target, reporter)  # 缺失/损坏的 zip 路径按 zip 校验，报 file_not_found
        reporter.print_summary('校验 %s' % target)
        return 0 if reporter.is_ok() else 1

    # --pack
    if not args.out:
        print('[错误] --pack 需要 --out <zip> 指定输出路径')
        return 1
    ok = pack_dir(args.pack, args.out, args.actions, args.thumb, reporter)
    reporter.print_summary('打包 %s' % args.pack)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
