"""动作窗口选择与循环接缝优化。

相对原 ``process_action.py`` 的改进：
- 循环动作不仅看首尾「像不像」，还看接缝运动量是否接近窗口内的正常帧间运动；
- 自动识别并裁掉「首尾几乎重复」的定格帧，避免循环时出现一帧停顿；
- 仍保留 headHold / tailHold（动作前后回到站姿）与抖动/裁切惩罚。
"""
from __future__ import annotations

import numpy as np

from .chroma import mask_iou


def _thumb_diff(a: dict, b: dict) -> float:
    """角色区域上的缩略图差异（忽略透明背景）。"""
    mask = (a['thumbAlpha'] > 32) | (b['thumbAlpha'] > 32)
    if not mask.any():
        return 0.0
    diff = np.abs(a['thumb'].astype(np.float32) - b['thumb'].astype(np.float32)).mean(axis=2)
    return float(diff[mask].mean())


def _feature(metric: dict) -> np.ndarray:
    return np.array([metric['headCx'], metric['foot'],
                     metric['bbox'][0] + metric['width'] / 2.0,
                     metric['bbox'][1] + metric['height'] / 2.0], dtype=np.float32)


def frame_similarity(m1: dict, m2: dict) -> float:
    iou = mask_iou(m1['alpha'], m2['alpha'])
    mae = _thumb_diff(m1, m2) / 255.0
    return 0.6 * iou + 0.4 * (1.0 - mae)


def _window_metrics(metrics: list[dict], start: int, end: int) -> dict:
    window = metrics[start:end]
    adjs = [_thumb_diff(metrics[i], metrics[i + 1]) for i in range(start, end - 1)]
    adj_median = float(np.median(adjs)) if adjs else 1.0
    seam_diff = _thumb_diff(metrics[end - 1], metrics[start]) if end - start > 1 else 0.0
    seam_ratio = seam_diff / max(adj_median, 1e-3)
    if end - start >= 3:
        v_before = _feature(metrics[end - 1]) - _feature(metrics[end - 2])
        v_after = _feature(metrics[start + 1]) - _feature(metrics[start])
        scale = max(1.0, float(np.mean([m['height'] for m in window])))
        vel_mismatch = float(np.linalg.norm(v_before - v_after) / scale)
    else:
        vel_mismatch = 0.0
    return {
        'adjMedian': adj_median,
        'seamDiff': seam_diff,
        'seamRatio': seam_ratio,
        'velMismatch': vel_mismatch,
    }


def select_window(metrics: list[dict], want: int, loop: bool) -> tuple[int, int, dict]:
    """在 metrics 序列中选 want 帧窗口，返回 [start, end) 与评分信息。"""
    n = len(metrics)
    want = max(1, min(want, n))
    if n <= want:
        return 0, n, {'start': 0, 'end': n, 'score': 0.0, 'headHold': 1.0,
                      'tailHold': 1.0, 'motion': 0.0, 'jitter': 0.0,
                      'cropPenalty': 0.0, **(_window_metrics(metrics, 0, n) if loop else {})}

    ref = metrics[0]
    hold_len = min(6, max(2, want // 6))
    best = None
    candidates = []
    for start in range(0, n - want + 1):
        end = start + want
        head_hold = float(np.mean([frame_similarity(metrics[i], ref)
                                   for i in range(start, min(start + hold_len, end))]))
        tail_hold = float(np.mean([frame_similarity(metrics[i], ref)
                                   for i in range(max(start, end - hold_len), end)]))
        ious = [mask_iou(metrics[i]['alpha'], metrics[i + 1]['alpha']) for i in range(start, end - 1)]
        alpha_motion = float(np.mean([1.0 - v for v in ious])) if ious else 0.0
        color_motion = float(np.mean([_thumb_diff(metrics[i], metrics[i + 1])
                                      for i in range(start, end - 1)])) / 255.0 if ious else 0.0
        # 手臂在身体轮廓内移动时 alpha IoU 变化很小，必须结合颜色差异；
        # motion 同时包含「轮廓变化」与「画面变化」，避免把静止 hold 当成动作。
        motion = 0.5 * alpha_motion + 0.5 * color_motion
        cxs = np.array([m['headCx'] for m in metrics[start:end]])
        fys = np.array([m['foot'] for m in metrics[start:end]])
        jitter = float(np.mean(np.abs(np.diff(cxs))) + np.mean(np.abs(np.diff(fys)))) if len(cxs) > 1 else 0.0
        crop_penalty = sum(0.08 for m in metrics[start:end] if m['touchesEdge'])
        heights = np.array([m['height'] for m in metrics[start:end]])
        h_penalty = float(np.std(heights) / max(1.0, np.mean(heights)) * 8.0)
        # 单次动作必须优先选到「动作段」，不能被片头/片尾的静止 hold 骗到；
        # 循环动作则更看重首尾姿态与动作幅度。
        motion_weight = 3.0 if loop else 8.0
        base_score = head_hold * (1.2 if loop else 1.0) + tail_hold * (1.2 if loop else 1.0)
        base_score += motion * motion_weight - jitter * 0.02 - crop_penalty - h_penalty
        if not loop and motion < 0.025:
            base_score -= 1.0
        score = base_score
        info = {'start': start, 'end': end, 'score': score, 'baseScore': base_score,
                'headHold': head_hold, 'tailHold': tail_hold,
                'motion': motion, 'jitter': jitter, 'cropPenalty': crop_penalty}
        if loop:
            wm = _window_metrics(metrics, start, end)
            # 原始帧存在整体位移/镜头漂移，接缝差异只能做弱约束；
            # 真正的接缝质量在渲染后由 trim_rendered_loop 再优化一次。
            loop_score = mask_iou(metrics[start]['alpha'], metrics[end - 1]['alpha']) * 1.0
            loop_score -= abs(float(np.log(max(wm['seamRatio'], 1e-3)))) * 0.35
            loop_score -= wm['velMismatch'] * 1.5
            score += loop_score
            info.update(wm)
            info['loopScore'] = loop_score
        info['score'] = score
        candidates.append(info)
        if best is None or score > best['score']:
            best = info
    best = dict(best)
    best['candidates'] = sorted(candidates, key=lambda item: item['baseScore'], reverse=True)[:12]
    return best['start'], best['end'], best


def optimize_loop_endpoints(metrics: list[dict], start: int, end: int) -> tuple[int, int, dict]:
    """裁掉循环首尾几乎重复的定格帧（原始帧空间的弱优化）。

    仅在接缝差异明显低于窗口内正常帧间差异时触发；优先保持窗口长度，
    空间不足时允许缩短 1 帧。返回新的 [start, end) 与诊断信息。
    """
    n = len(metrics)
    before = _window_metrics(metrics, start, end)
    if before['seamRatio'] >= 0.45 or end - start < 8:
        return start, end, {'optimized': False, **before}

    candidates = []
    if end - start > 8:
        s2 = start + 1
        e2 = end + 1 if end < n else end
        candidates.append(('drop-first', s2, e2))
    if end - start > 8:
        e2 = end - 1
        s2 = start - 1 if start > 0 else start
        candidates.append(('drop-last', s2, e2))

    best = None
    for label, s2, e2 in candidates:
        if e2 - s2 < 8:
            continue
        wm = _window_metrics(metrics, s2, e2)
        pose = frame_similarity(metrics[s2], metrics[0]) + frame_similarity(metrics[e2 - 1], metrics[0])
        score = -abs(float(np.log(max(wm['seamRatio'], 1e-3)))) - wm['velMismatch'] * 2.0 - pose * 0.15
        if best is None or score > best[0]:
            best = (score, label, s2, e2, wm, pose)

    if best is None:
        return start, end, {'optimized': False, **before}
    _, label, s2, e2, wm, pose = best
    if wm['seamRatio'] < 0.45 and before['seamRatio'] < 0.2:
        return start, end, {'optimized': False, **before}
    return s2, e2, {'optimized': True, 'reason': label, 'posePenalty': pose, **wm}


def _rendered_diff(a: np.ndarray, b: np.ndarray) -> float:
    mask = (a[:, :, 3] > 32) | (b[:, :, 3] > 32)
    if not mask.any():
        return 0.0
    diff = np.abs(a[:, :, :3].astype(np.int16) - b[:, :, :3].astype(np.int16)).mean(axis=2)
    return float(diff[mask].mean())


def rendered_seam_metrics(frames: list[np.ndarray]) -> dict:
    """在已渲染的 RGBA 帧上量接缝：seamRatio≈1 表示与正常帧间运动一致。"""
    if len(frames) < 3:
        return {'adjMedian': 1.0, 'seamDiff': 0.0, 'seamRatio': 1.0}
    adjs = [_rendered_diff(frames[i], frames[i + 1]) for i in range(len(frames) - 1)]
    adj_median = float(np.median(adjs)) if adjs else 1.0
    seam_diff = _rendered_diff(frames[-1], frames[0])
    return {
        'adjMedian': adj_median,
        'seamDiff': seam_diff,
        'seamRatio': seam_diff / max(adj_median, 1e-3),
    }


def trim_rendered_loop(frames: list[np.ndarray], threshold: float = 0.72) -> tuple[list[np.ndarray], dict]:
    """在渲染后的帧上裁掉循环首尾的重复定格，避免循环时出现停顿。

    只做「去掉第一帧」或「去掉最后一帧」两种最小改动；选择接缝 ratio 更接近 1
    且动作长度损失最小的方案。接缝本来就正常时原样返回。
    """
    before = rendered_seam_metrics(frames)
    if len(frames) < 8 or before['seamRatio'] >= threshold:
        return frames, {'trimmed': False, **before}

    candidates = []
    if len(frames[1:]) >= 6:
        after = rendered_seam_metrics(frames[1:])
        candidates.append(('drop-first', frames[1:], after))
    if len(frames[:-1]) >= 6:
        after = rendered_seam_metrics(frames[:-1])
        candidates.append(('drop-last', frames[:-1], after))

    best = None
    for label, candidate, info in candidates:
        # 目标 ratio=1；同时轻微偏好保留更多帧
        score = -abs(float(np.log(max(info['seamRatio'], 1e-3)))) + len(candidate) * 0.001
        if best is None or score > best[0]:
            best = (score, label, candidate, info)
    if best is None:
        return frames, {'trimmed': False, **before}
    _, label, candidate, info = best
    # 只有比原来更接近 1 才采用
    if abs(np.log(max(info['seamRatio'], 1e-3))) >= abs(np.log(max(before['seamRatio'], 1e-3))):
        return frames, {'trimmed': False, **before}
    return candidate, {'trimmed': True, 'reason': label, 'before': before, **info}
