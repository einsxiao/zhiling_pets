"""视频 / 图片序列 → 统一 RGB 帧列表。

优先使用 OpenCV 解码（无外部 ffmpeg 依赖）。对于已经抽好的图片序列，
可直接用 ``--from-frames`` 跳过视频解码。
"""
from __future__ import annotations

import glob
import os
import re

import cv2
import numpy as np


def _natural_key(path: str):
    name = os.path.basename(path)
    return [int(part) if part.isdigit() else part.lower()
            for part in re.split(r'(\d+)', name)]


class VideoSourceError(RuntimeError):
    pass


def _read_video_frames(cap: cv2.VideoCapture, start_time: float, end_time: float,
                       native_fps: float, target_fps: float) -> list[np.ndarray]:
    """按目标帧率从视频中顺序取样（避免逐帧 seek）。"""
    frames: list[np.ndarray] = []
    start_frame = max(0, int(round(start_time * native_fps)))
    end_frame = max(start_frame, int(round(end_time * native_fps)))
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
    next_time = start_time
    index = start_frame
    tolerance = 0.45 / max(native_fps, 1e-6)
    while index <= end_frame:
        ok, frame = cap.read()
        if not ok:
            break
        now = index / native_fps
        if now + tolerance >= next_time:
            frames.append(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            next_time += 1.0 / target_fps
            if next_time > end_time + 1e-6:
                break
        index += 1
    return frames


def extract_video_frames(video_path: str, fps: float = 12.0,
                         start: float | None = None,
                         end: float | None = None,
                         max_frames: int | None = None) -> list[np.ndarray]:
    """读取视频并按目标 fps 取样，返回 RGB numpy 帧列表。"""
    if not os.path.isfile(video_path):
        raise VideoSourceError(f'视频不存在：{video_path}')
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise VideoSourceError(f'无法打开视频（编码不受支持？）：{video_path}')
    try:
        native_fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
        if native_fps <= 0:
            native_fps = 30.0
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        duration = total / native_fps if total > 0 else 0.0
        start_time = max(0.0, float(start or 0.0))
        end_time = float(end) if end is not None else duration
        if end_time <= start_time:
            raise VideoSourceError(f'视频时间范围非法：{start_time}..{end_time}（总长 {duration:.2f}s）')
        frames = _read_video_frames(cap, start_time, end_time, native_fps, fps)
    finally:
        cap.release()
    if not frames:
        raise VideoSourceError('视频没有解出任何帧，检查编码或时间范围')
    if max_frames and len(frames) > max_frames:
        frames = frames[:max_frames]
    return frames


def read_image_sequence(directory: str, max_frames: int | None = None) -> list[np.ndarray]:
    """读取目录内的 jpg/png/webp 图片序列（按文件名自然排序）。"""
    if not os.path.isdir(directory):
        raise VideoSourceError(f'帧目录不存在：{directory}')
    names = []
    for pattern in ('*.jpg', '*.jpeg', '*.png', '*.webp'):
        names.extend(glob.glob(os.path.join(directory, pattern)))
    if not names:
        raise VideoSourceError(f'帧目录没有 jpg/png/webp：{directory}')
    names.sort(key=_natural_key)
    if max_frames:
        names = names[:max_frames]
    frames = []
    for name in names:
        image = cv2.imread(name, cv2.IMREAD_UNCHANGED)
        if image is None:
            raise VideoSourceError(f'图片读取失败：{name}')
        if image.ndim == 2:
            image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
        if image.shape[2] == 4:
            image = cv2.cvtColor(image, cv2.COLOR_BGRA2BGR)
        else:
            image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        frames.append(image)
    return frames
