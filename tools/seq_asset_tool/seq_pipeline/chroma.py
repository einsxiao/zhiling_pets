"""绿幕色键、alpha 清理、去绿溢与帧级度量。

这里是原先 ``whale_gril/chibi_seq/tools/process_action.py`` 中通用图像处理的
稳定副本，供流水线复用；不依赖项目内其它文件。
"""
from __future__ import annotations

import cv2
import numpy as np


def chroma_alpha(rgb: np.ndarray, soft: int = 45, low: int = 12) -> np.ndarray:
    """绿幕软阈值 alpha。

    greenness = G - max(R, B)：
    - greenness >= soft → 背景（alpha 0）
    - greenness <= low  → 角色（alpha 255）
    - 中间线性过渡
    """
    arr = rgb.astype(np.int16)
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    greenness = g - np.maximum(r, b)
    alpha = np.clip((greenness - low) / float(max(1, soft - low)) * 255.0, 0, 255)
    return (255 - alpha).astype(np.uint8)


def clean_alpha(alpha: np.ndarray, keep_ratio: float = 0.0008) -> np.ndarray:
    """形态学清理 + 连通域过滤（保留主角色与足够大的分离碎片）。"""
    k3 = np.ones((3, 3), np.uint8)
    a = cv2.morphologyEx(alpha, cv2.MORPH_OPEN, k3, iterations=1)
    a = cv2.morphologyEx(a, cv2.MORPH_CLOSE, k3, iterations=2)
    hard = (a > 40).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(hard, 8)
    if n <= 1:
        return a
    max_area = int(st[1:, cv2.CC_STAT_AREA].max())
    keep = np.zeros_like(a)
    for i in range(1, n):
        if int(st[i, cv2.CC_STAT_AREA]) >= max(24, int(max_area * keep_ratio)):
            keep[lab == i] = 255
    return (a * (keep > 0)).astype(np.uint8)


def despill(rgb: np.ndarray, alpha: np.ndarray, strength: float = 1.0) -> np.ndarray:
    """边缘去绿溢：G 不超过 max(R, B) 的 strength 倍。"""
    out = rgb.copy()
    r = out[:, :, 0].astype(np.int16)
    g = out[:, :, 1].astype(np.int16)
    b = out[:, :, 2].astype(np.int16)
    edge = (alpha > 0) & (alpha < 252)
    cap = np.maximum(r, b)
    fix = edge & (g > cap)
    g[fix] = cap[fix]
    if strength > 1.0:
        k = np.ones((3, 3), np.uint8)
        edge2 = cv2.dilate(edge.astype(np.uint8), k, iterations=1) > 0
        cap2 = np.maximum(r, b)
        fix2 = edge2 & (g > cap2)
        g[fix2] = cap2[fix2]
    out[:, :, 1] = np.clip(g, 0, 255).astype(np.uint8)
    return out


def alpha_bbox(alpha: np.ndarray, threshold: int = 24):
    ys, xs = np.where(alpha > threshold)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def mask_iou(a: np.ndarray, b: np.ndarray) -> float:
    ha = a > 96
    hb = b > 96
    inter = np.logical_and(ha, hb).sum()
    union = np.logical_or(ha, hb).sum()
    return float(inter / union) if union else 0.0


def head_center_x(alpha: np.ndarray, bbox) -> float:
    """头部/上身区域的 alpha 质心 x（不受尾巴摆动影响）。"""
    x0, y0, x1, y1 = bbox
    h = y1 - y0
    region = alpha[y0:y0 + max(1, int(h * 0.38)), :]
    ys, xs = np.where(region > 96)
    if len(xs) == 0:
        return (x0 + x1) / 2.0
    return float(xs.mean())


def foot_base_y(alpha: np.ndarray, bbox) -> float:
    """中间 50% 宽度区域的 alpha 最低点（避开右侧尾巴）。"""
    x0, y0, x1, y1 = bbox
    cx = (x0 + x1) // 2
    half = max(1, int((x1 - x0) * 0.25))
    region = alpha[:, max(0, cx - half):min(alpha.shape[1], cx + half)]
    ys, xs = np.where(region > 96)
    if len(ys) == 0:
        return float(y1)
    return float(ys.max())


def medfilt(seq, k: int = 5):
    """一维中值滤波（边界复制），用于提取慢速趋势。"""
    arr = np.asarray(seq, dtype=np.float32)
    k = max(1, int(k) | 1)
    pad = k // 2
    padded = np.pad(arr, (pad, pad), mode='edge')
    return np.array([np.median(padded[i:i + k]) for i in range(len(arr))], dtype=np.float32)


def premultiply_resize(rgb: np.ndarray, alpha: np.ndarray, new_w: int, new_h: int):
    """预乘 alpha 缩放，避免透明区的绿色被插值进角色边缘；再二次去绿溢。"""
    f = rgb.astype(np.float32) / 255.0
    a = alpha.astype(np.float32) / 255.0
    pre = f * a[..., None]
    pre_s = cv2.resize(pre, (new_w, new_h), interpolation=cv2.INTER_LANCZOS4)
    a_s = cv2.resize(a, (new_w, new_h), interpolation=cv2.INTER_LANCZOS4)
    a_s = np.clip(a_s, 0.0, 1.0)
    rgb_s = np.clip(pre_s / np.maximum(a_s[..., None], 1e-6), 0.0, 1.0) * 255.0
    rgb_s = rgb_s.astype(np.uint8)
    a_u8 = np.clip(a_s * 255.0, 0, 255).astype(np.uint8)
    rgb_s = despill(rgb_s, a_u8, strength=1.0)
    return rgb_s, a_u8


def frame_metrics(rgb: np.ndarray, thumb_size: int = 64) -> dict | None:
    """计算单帧色键 alpha 与后续选窗需要的度量。"""
    alpha = clean_alpha(chroma_alpha(rgb))
    bbox = alpha_bbox(alpha)
    if bbox is None:
        return None
    x0, y0, x1, y1 = bbox
    h, w = alpha.shape
    thumb = cv2.resize(rgb, (thumb_size, thumb_size), interpolation=cv2.INTER_AREA)
    thumb_alpha = cv2.resize(alpha, (thumb_size, thumb_size), interpolation=cv2.INTER_AREA)
    return {
        'rgb': rgb,
        'alpha': alpha,
        'bbox': bbox,
        'thumb': thumb,
        'thumbAlpha': thumb_alpha,
        'headCx': head_center_x(alpha, bbox),
        'foot': foot_base_y(alpha, bbox),
        'height': float(y1 - y0),
        'width': float(x1 - x0),
        'greenRatio': 1.0 - float((alpha > 96).mean()),
        'touchesEdge': bool(x0 <= 2 or y0 <= 2 or x1 >= w - 2 or y1 >= h - 2),
    }
