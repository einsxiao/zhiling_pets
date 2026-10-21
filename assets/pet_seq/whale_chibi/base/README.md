# 基础帧与原画（whale_chibi）

本目录是 `whale_chibi` 所有动作的**零姿态基准**。新动作的第一帧与最后一帧都必须回到
`frame_000.webp` 的姿态；已有动作不得各自重绘基础姿态。

| 文件 | 规格 | 用途 |
|---|---|---|
| `frame_000.webp` | 768×1024 RGBA WebP，透明底 | **规范基础帧**：与动作帧同规格，用于首尾对齐、抽帧选窗与叠加比对 |
| `artwork.png` | 1024×1024 RGBA PNG，白底 | **原画**：角色设定与细节参考（发型、发饰、服装、鲸尾、配色），不参与运行时播放 |

约定：

- `frame_000.webp` 与 `whale_chibi/idle/frame_000.webp` 保持逐字节一致；修改基础帧等于重做全部动作。
- 生成动作视频时，把 `frame_000.webp` 同时作为 Seedance 的首帧和末帧；
  需要 720×1280 绿幕版时，用 `assets/whale_gril/chibi_seq/tools/make_first_frame.py` 重新生成，
  不要把绿幕图放回本目录。
- `artwork.png` 只作参考，不参与 `tools/pack_2d_frames.py` 的帧校验，也不会被运行时加载。
- 本目录不进入资产包；打包时只取 `whale_chibi/<action>/`。
