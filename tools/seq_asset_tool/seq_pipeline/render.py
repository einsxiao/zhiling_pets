"""统一画布渲染：缩放、脚底基准、趋势去抖、预乘 alpha 缩放。"""
from __future__ import annotations

import numpy as np

from .chroma import alpha_bbox, despill, mask_iou, medfilt, premultiply_resize


def build_context(metrics_window: list[dict], canvas: tuple[int, int] = (768, 1024),
                  foot_line: int = 980, target_height: int = 800,
                  margin: int = 24, max_x_shift: int = 8) -> dict:
    """根据窗口整体统计量建立统一缩放/脚底/去抖上下文。"""
    cw, ch = canvas
    heights = np.array([m['height'] for m in metrics_window], dtype=np.float32)
    widths = np.array([m['width'] for m in metrics_window], dtype=np.float32)
    h_med = float(np.median(heights))
    w_med = float(np.median(widths))
    aspect = w_med / max(1.0, h_med)
    max_h_by_width = (cw - 2 * margin) / max(1e-6, aspect)
    target_h = min(float(target_height), max_h_by_width)
    scale = target_h / max(1.0, h_med)

    cxs = np.array([m['headCx'] for m in metrics_window], dtype=np.float32)
    feet = np.array([m['foot'] for m in metrics_window], dtype=np.float32)
    trend_cx = medfilt(cxs, 5)
    trend_foot = medfilt(feet, 5)
    return {
        'canvas': (cw, ch),
        'footLine': foot_line,
        'maxXShift': max_x_shift,
        'scale': scale,
        'targetHeight': target_h,
        'trendCx': trend_cx,
        'trendFoot': trend_foot,
        'baseCx': float(np.median(trend_cx)),
        'baseFoot': float(np.median(trend_foot)),
    }


def render_frame(metric: dict, local_index: int, ctx: dict) -> np.ndarray:
    """把窗口内第 local_index 帧渲染到统一画布。"""
    cw, ch = ctx['canvas']
    scale = ctx['scale']
    rgb = despill(metric['rgb'], metric['alpha'])
    new_w = max(1, int(round(rgb.shape[1] * scale)))
    new_h = max(1, int(round(rgb.shape[0] * scale)))
    rgb_s, a_s = premultiply_resize(rgb, metric['alpha'], new_w, new_h)
    rgba = np.dstack([rgb_s, a_s])

    shift_x = float(np.clip((ctx['trendCx'][local_index] - ctx['baseCx']) * scale,
                            -ctx['maxXShift'], ctx['maxXShift']))
    target_cx = (cw / 2.0) + shift_x
    target_foot = ctx['footLine'] + (ctx['trendFoot'][local_index] - ctx['baseFoot']) * scale
    x = int(round(target_cx - new_w / 2.0))
    y = int(round(target_foot - new_h))

    canvas = np.zeros((ch, cw, 4), np.uint8)
    sx0, sy0 = max(0, -x), max(0, -y)
    dx0, dy0 = max(0, x), max(0, y)
    w_copy = min(new_w - sx0, cw - dx0)
    h_copy = min(new_h - sy0, ch - dy0)
    if w_copy > 0 and h_copy > 0:
        canvas[dy0:dy0 + h_copy, dx0:dx0 + w_copy] = rgba[sy0:sy0 + h_copy, sx0:sx0 + w_copy]
    return canvas


def render_window(metrics_window: list[dict], canvas: tuple[int, int] = (768, 1024),
                  foot_line: int = 980, target_height: int = 800,
                  margin: int = 24, max_x_shift: int = 8) -> tuple[list[np.ndarray], dict]:
    """把选中的帧渲染到统一画布，返回 RGBA 帧与统计信息。"""
    ctx = build_context(metrics_window, canvas, foot_line, target_height, margin, max_x_shift)
    frames = [render_frame(m, i, ctx) for i, m in enumerate(metrics_window)]

    max_dx = max_dy = 0.0
    for i, m in enumerate(metrics_window):
        max_dx = max(max_dx, abs(float(m['headCx'] - ctx['trendCx'][i])))
        max_dy = max(max_dy, abs(float(m['foot'] - ctx['trendFoot'][i])))

    cw, ch = canvas
    loop_iou = mask_iou(frames[0][:, :, 3], frames[-1][:, :, 3])
    out_bboxes = [alpha_bbox(f[:, :, 3]) for f in frames]
    clipped = [i for i, bb in enumerate(out_bboxes)
               if bb is None or bb[0] <= 0 or bb[1] <= 0 or bb[2] >= cw or bb[3] >= ch]
    meta = {
        'scale': round(ctx['scale'], 5),
        'targetHeightPx': round(ctx['targetHeight'], 2),
        'footLine': foot_line,
        'maxJitterPx': {'x': round(max_dx * ctx['scale'], 3), 'y': round(max_dy * ctx['scale'], 3)},
        'loopIoU': round(loop_iou, 4),
        'outBBoxes': out_bboxes,
        'clippedOutputFrames': clipped,
        'canvas': [cw, ch],
    }
    return frames, meta
