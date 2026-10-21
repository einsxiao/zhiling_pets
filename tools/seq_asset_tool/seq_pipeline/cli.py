"""seq_pipeline 命令行入口：绿幕视频 → 资产库动作。"""
from __future__ import annotations

import argparse
import json
import os
import sys

from .chroma import frame_metrics
from .library import (
    DEFAULT_RUNTIME_ACTIONS,
    ID_RE,
    LibraryError,
    ensure_action,
    find_avatar,
    load_manifest,
    resolve_library_root,
    save_manifest,
    timestamp_label,
    write_action_frames,
    write_generation_log,
)
from .render import build_context, render_frame, render_window
from .video_source import VideoSourceError, extract_video_frames, read_image_sequence
from .window import rendered_seam_metrics, select_window, trim_rendered_loop


def _parse_canvas(value: str) -> tuple[int, int]:
    try:
        w, h = value.lower().split('x')
        return int(w), int(h)
    except Exception as exc:
        raise argparse.ArgumentTypeError('画布格式应为 768x1024') from exc


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog='python -m seq_pipeline',
        description='绿幕视频 → 2D 序列帧动作（色键、选窗、循环接缝优化、WebP 入库）',
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--video', help='绿幕视频路径（mp4/mov/webm 等，OpenCV 可解码）')
    source.add_argument('--from-frames', help='已抽好的图片序列目录（jpg/png/webp）')
    parser.add_argument('--avatar', required=True, help='形象 id，例如 whale_chibi')
    parser.add_argument('--action', required=True, help='动作 id，例如 idle / wave / happy')
    parser.add_argument('--label', help='动作显示名（新动作默认使用动作 id）')
    parser.add_argument('--description', help='动作内容描述（面向大模型/UI；单行 ≤200 码点）')
    parser.add_argument('--note', help='动作备注（默认记录来源视频与参数）')
    parser.add_argument('--fps', type=float, default=12.0, help='目标帧率（默认 12）')
    parser.add_argument('--frames', type=int, default=36, help='期望帧数（默认 36；素材不足时取全部）')
    parser.add_argument('--max-frames', type=int, default=240, help='最多解码帧数，防止长视频吃内存（默认 240）')
    parser.add_argument('--start', type=float, default=None, help='视频起始秒（可选）')
    parser.add_argument('--end', type=float, default=None, help='视频结束秒（可选）')
    loop_group = parser.add_mutually_exclusive_group()
    loop_group.add_argument('--loop', dest='loop', action='store_true', help='循环动作（idle/sleepy/dance 等）')
    loop_group.add_argument('--no-loop', dest='loop', action='store_false', help='单次动作（wave/happy 等）')
    parser.set_defaults(loop=None)
    parser.add_argument('--window-start', type=int, default=None, help='手动指定窗口起始帧（0-based）')
    parser.add_argument('--canvas', type=_parse_canvas, default=(768, 1024), help='输出画布，默认 768x1024')
    parser.add_argument('--foot-line', type=int, default=980, help='脚底基准 y（默认 980）')
    parser.add_argument('--target-height', type=int, default=800, help='角色目标高度上限 px（默认 800）')
    parser.add_argument('--margin', type=int, default=24, help='左右安全边距 px（默认 24）')
    parser.add_argument('--max-x-shift', type=int, default=8, help='水平趋势位移上限 px（默认 8）')
    parser.add_argument('--quality', type=int, default=82, help='WebP 质量（默认 82）')
    parser.add_argument('--method', type=int, default=4, help='WebP 编码 method 0-6（默认 4）')
    parser.add_argument('--dry-run', action='store_true', help='只生成预览 PNG，不写资产库')
    parser.add_argument('--preview-dir', help='dry-run 预览输出目录')
    parser.add_argument('--library-root', help='覆盖资产库根目录（默认 tools/seq_asset_tool/../../assets/pet_seq）')
    parser.add_argument('--json', action='store_true', help='最后输出一行 JSON 结果（供工作台调用）')
    return parser


def _read_source(args) -> list:
    if args.video:
        frames = extract_video_frames(args.video, fps=args.fps, start=args.start,
                                      end=args.end, max_frames=args.max_frames)
        return frames
    return read_image_sequence(args.from_frames, max_frames=args.max_frames)


def _loop_value(args, manifest: dict, avatar_id: str, action_id: str) -> bool:
    if args.loop is not None:
        return bool(args.loop)
    avatar = find_avatar(manifest, avatar_id)
    action = next((item for item in avatar.get('actions', []) if item.get('id') == action_id), None)
    if action is not None:
        return bool(action.get('loop'))
    return action_id == 'idle'


def _default_note(args, frames: int) -> str:
    origin = os.path.basename(args.video) if args.video else os.path.basename(os.path.abspath(args.from_frames))
    return f'由绿幕素材生成：{origin}；{frames} 帧 @ {args.fps:g}fps。'


def _rendered_seam_ratio(metrics: list, start: int, end: int, args) -> tuple[float, str]:
    """评估窗口在「不裁剪 / 去首帧 / 去尾帧」三种情况下的最佳循环接缝。

    返回 (ratio, label)，ratio 越接近 1 越好；优先选择裁剪后可达的最佳值，
    与后续 trim_rendered_loop 的实际行为保持一致。
    """
    window = metrics[start:end]
    n = len(window)
    if n < 6:
        return 1.0, 'original'
    ctx = build_context(window, canvas=args.canvas, foot_line=args.foot_line,
                        target_height=args.target_height, margin=args.margin,
                        max_x_shift=args.max_x_shift)
    indexes = sorted({0, 1, 2, n - 3, n - 2, n - 1})
    frames = {i: render_frame(window[i], i, ctx) for i in indexes}

    def diff(a, b):
        mask = (a[:, :, 3] > 32) | (b[:, :, 3] > 32)
        if not mask.any():
            return 0.0
        d = abs(a[:, :, :3].astype(int) - b[:, :, :3].astype(int)).mean(axis=2)
        import numpy as np
        return float(d[mask].mean())

    import numpy as np
    variants = []
    # 不裁剪
    adj0 = float(np.median([diff(frames[0], frames[1]), diff(frames[n - 2], frames[n - 1])]))
    variants.append(('original', diff(frames[n - 1], frames[0]) / max(adj0, 1e-3)))
    # 去首帧：新循环从 1 开始
    adj1 = float(np.median([diff(frames[1], frames[2]), diff(frames[n - 2], frames[n - 1])]))
    variants.append(('drop-first', diff(frames[n - 1], frames[1]) / max(adj1, 1e-3)))
    # 去尾帧：新循环到 n-2 结束
    adj2 = float(np.median([diff(frames[0], frames[1]), diff(frames[n - 3], frames[n - 2])]))
    variants.append(('drop-last', diff(frames[n - 2], frames[0]) / max(adj2, 1e-3)))
    label, ratio = min(variants, key=lambda item: abs(float(np.log(max(item[1], 1e-3)))))
    return ratio, label


def pick_rendered_loop_candidate(metrics: list, start: int, end: int, info: dict, args) -> tuple[int, int, dict]:
    """在少量候选窗口中按「渲染后接缝 ratio 最接近 1」重选循环窗口。"""
    length = end - start
    max_start = len(metrics) - length
    if max_start + 1 <= 20:
        # 短视频（常见 4s 素材）直接穷举所有窗口，保证接缝最优
        starts = set(range(0, max_start + 1))
    else:
        starts = set()
        for candidate in (info.get('candidates') or [])[:8]:
            starts.add(int(candidate['start']))
        for delta in (-3, -2, -1, 0, 1, 2, 3):
            s = start + delta
            if 0 <= s <= max_start:
                starts.add(s)
    best = None
    for s in sorted(starts):
        e = s + length
        if e > len(metrics) or e - s < 6:
            continue
        ratio, trim_label = _rendered_seam_ratio(metrics, s, e, args)
        base = next((float(c.get('baseScore', 0)) for c in (info.get('candidates') or [])
                     if int(c.get('start', -1)) == s), float(info.get('baseScore', 0)))
        score = -abs(float(__import__('math').log(max(ratio, 1e-3)))) * 3.0 + base * 0.25
        if best is None or score > best[0]:
            best = (score, s, e, ratio, trim_label)
    if best is None:
        return start, end, info
    _, s, e, ratio, trim_label = best
    updated = dict(info)
    updated['loopCandidate'] = {
        'from': [start, end], 'to': [s, e],
        'renderedSeamRatio': round(ratio, 4), 'trim': trim_label,
    }
    if s != start or e != end:
        print(f'[seq_pipeline] 循环候选重选: {start}..{end - 1} → {s}..{e - 1}'
              f'（seamRatio={ratio:.3f}, trim={trim_label}）')
    return s, e, updated


def run(args) -> dict:
    if not ID_RE.match(args.action):
        raise LibraryError(f'动作 id 非法：{args.action}（只能字母/数字/_/-）')
    if not ID_RE.match(args.avatar):
        raise LibraryError(f'形象 id 非法：{args.avatar}')
    if args.fps <= 0:
        raise LibraryError(f'帧率必须大于 0：{args.fps}')
    args.quality = max(0, min(100, int(args.quality)))
    args.method = max(0, min(6, int(args.method)))

    library_root = resolve_library_root(args.library_root)
    manifest = load_manifest(library_root)
    runtime_actions = list(DEFAULT_RUNTIME_ACTIONS)

    print(f'[seq_pipeline] 资产库: {library_root}')
    print(f'[seq_pipeline] 读取素材…')
    source_frames = _read_source(args)
    print(f'[seq_pipeline] 解码得到 {len(source_frames)} 帧（fps={args.fps:g}）')

    metrics = []
    for index, rgb in enumerate(source_frames):
        item = frame_metrics(rgb)
        if item is None:
            print(f'  ! 第 {index} 帧 alpha 为空，跳过')
            continue
        item['index'] = index
        metrics.append(item)
    if len(metrics) < 2:
        raise LibraryError('有效帧不足 2 帧，检查绿幕质量或素材')

    want = max(2, min(args.frames, len(metrics)))
    if args.window_start is not None:
        start = max(0, int(args.window_start))
        end = min(len(metrics), start + want)
        info = {'manual': True, 'start': start, 'end': end}
        if end - start < 2:
            raise LibraryError('手动窗口不足 2 帧')
    else:
        start, end, info = select_window(metrics, want, _loop_value(args, manifest, args.avatar, args.action))
    loop = _loop_value(args, manifest, args.avatar, args.action)
    if loop and args.window_start is None:
        start, end, info = pick_rendered_loop_candidate(metrics, start, end, info, args)
    print(f'[seq_pipeline] 选窗: {start}..{end - 1}（{end - start} 帧，loop={loop}）')
    print(f'  headHold={info.get("headHold", 0):.3f} tailHold={info.get("tailHold", 0):.3f} '
          f'motion={info.get("motion", 0):.3f} seamRatio={info.get("seamRatio", 0):.3f} '
          f'velMismatch={info.get("velMismatch", 0):.3f}')
    if info.get('loopOptimize'):
        print(f'  loopOptimize={info["loopOptimize"]}')

    rendered, render_meta = render_window(
        metrics[start:end], canvas=args.canvas, foot_line=args.foot_line,
        target_height=args.target_height, margin=args.margin,
        max_x_shift=args.max_x_shift,
    )
    print(f'[seq_pipeline] 渲染 {len(rendered)} 帧，scale={render_meta["scale"]:.4f} '
          f'loopIoU={render_meta["loopIoU"]:.4f} clipped={render_meta["clippedOutputFrames"] or "无"}')

    if loop and args.window_start is None:
        rendered, trim_info = trim_rendered_loop(rendered)
        seam_info = rendered_seam_metrics(rendered)
        render_meta['seam'] = {**trim_info, **seam_info}
        print(f'[seq_pipeline] 循环接缝: trimmed={trim_info.get("trimmed")} '
              f'seamRatio={seam_info["seamRatio"]:.3f} frames={len(rendered)}')
        if seam_info['seamRatio'] > 1.8 or seam_info['seamRatio'] < 0.5:
            print('[seq_pipeline] 警告: 循环接缝可能可见；建议调整 --frames / --window-start，'
                  '或使用首尾姿态更接近的素材。')

    existing_action = next(
        (item for item in find_avatar(manifest, args.avatar).get('actions', [])
         if item.get('id') == args.action),
        None,
    )
    note = args.note
    if note is None and existing_action is None:
        note = _default_note(args, len(rendered))
    action = ensure_action(
        manifest, args.avatar, args.action,
        label=args.label, loop=loop, fps=args.fps, runtime_actions=runtime_actions,
        note=note, description=args.description,
    )
    print(f'[seq_pipeline] 动作元数据: {action["id"]} / label={action["label"]} / loop={action["loop"]} / runtime={action["runtime"]}')
    if action.get('description'):
        print(f'[seq_pipeline] 动作描述: {action["description"]}')

    write_result = write_action_frames(
        library_root, args.avatar, args.action, rendered,
        quality=args.quality, method=args.method,
        dry_run=args.dry_run, preview_dir=args.preview_dir,
        meta=action,
    )
    print(f'[seq_pipeline] 写库: {write_result}')

    if not args.dry_run:
        save_manifest(library_root, manifest)
        print('[seq_pipeline] manifest 已更新')

    summary = {
        'ok': True,
        'avatar': args.avatar,
        'action': args.action,
        'loop': loop,
        'runtime': bool(action.get('runtime')),
        'sourceFrames': len(source_frames),
        'validFrames': len(metrics),
        'window': [start, end],
        'frames': len(rendered),
        'fps': args.fps,
        'render': render_meta,
        'write': write_result,
        'dryRun': bool(args.dry_run),
    }
    if not args.dry_run:
        summary['log'] = write_generation_log(library_root, args.avatar, args.action, {
            'generatedAt': timestamp_label(),
            'args': vars(args),
            'summary': summary,
        })
    return summary


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        summary = run(args)
    except (LibraryError, VideoSourceError) as error:
        print(f'[seq_pipeline] 失败: {error}', file=sys.stderr)
        if getattr(args, 'json', False):
            print('SEQ_PIPELINE_RESULT=' + json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
        return 2
    except Exception as error:  # noqa: BLE001 - CLI 需要把意外错误转成可读信息
        print(f'[seq_pipeline] 意外错误: {type(error).__name__}: {error}', file=sys.stderr)
        if getattr(args, 'json', False):
            print('SEQ_PIPELINE_RESULT=' + json.dumps({'ok': False, 'error': f'{type(error).__name__}: {error}'}, ensure_ascii=False))
        return 1
    if args.json:
        print('SEQ_PIPELINE_RESULT=' + json.dumps(summary, ensure_ascii=False))
    return 0
