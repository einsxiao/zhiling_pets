# seq_pipeline — 绿幕视频 → 2D 序列帧动作

把「绿幕视频 → 色键 → 选窗 → 统一画布 → WebP 入库 → 更新 manifest」
收敛成一条命令，后续做新动作时不用再分别改 `process_action.py`、手动转 WebP、手写 manifest。

> 也可以在资产工作台里直接导入视频：右侧「动作 → 从绿幕视频生成」，无需命令行；
> 工作台只是调用本目录的同一套流水线，参数与行为一致。

## 快速开始

```bat
cd tools\seq_asset_tool
run_pipeline.bat --video ..\..\assets\whale_gril\chibi_seq\video\wave.mp4 ^
  --avatar whale_chibi --action wave --no-loop
```

> 示例中的 `assets/whale_gril/...` 是维护者本地素材目录，**不随本仓库发布**；请替换为自己的绿幕视频路径。

- `run_pipeline.bat` 会切到工具目录：优先用本工具 `.venv` 里的 Python，没有则用 PATH 里的 `python`；
- Linux / macOS 用 `./run_pipeline.sh`（同样优先 `.venv`，否则 `python3`）。

## 环境

- Python 3.10+
- `opencv-python`、`numpy`、`Pillow`（推荐直接用 `requirements.txt`）

```bash
python -m pip install -r requirements.txt
python check_env.py      # 检查当前解释器是否齐备
```

> 最省事的方式：在资产工作台打开「导入绿幕视频」→「安装依赖（.venv）」，
> 工作台会在 `tools/seq_asset_tool/.venv` 创建隔离环境并安装上述依赖，之后命令行入口也会自动使用它。

不需要 ffmpeg：视频用 OpenCV 解码；如果某个编码 OpenCV 不支持，可先用其它工具抽成
图片序列，再用 `--from-frames <目录>`。

## 常用命令

### 1. 先预览，不写资产库

```bat
run_pipeline.bat --video <视频路径>\happy.mp4 --avatar whale_chibi --action happy --no-loop ^
  --frames 36 --dry-run --preview-dir .tmp_happy_preview
```

预览帧输出到 `--preview-dir`，不会改 manifest 或资产库。

### 2. 循环动作（idle / sleepy / think / dance）

```bat
run_pipeline.bat --video <视频路径>\idle.mp4 --avatar whale_chibi --action idle --loop ^
  --frames 36
```

循环动作会：

- 优先选首尾姿态接近、动作幅度足够的窗口；
- 在渲染后的画面上再量一次接缝，必要时自动去掉第一帧或最后一帧，
  避免「首尾几乎一样导致循环时停顿一帧」；
- 如果接缝仍然明显，打印警告，建议调整 `--frames` 或 `--window-start`。

### 3. 单次动作（wave / happy / bow / clap 等）

```bat
run_pipeline.bat --video <视频路径>\wave.mp4 --avatar whale_chibi --action wave --no-loop ^
  --frames 36
```

单次动作会优先选「动作段」，并尽量让结尾回到接近片头的站姿，便于播放完回 idle。

### 4. 手动指定窗口

自动选窗不适合时，用 `--window-start` 指定 0-based 起始帧：

```bat
run_pipeline.bat --video <视频路径>\wave.mp4 --avatar whale_chibi --action wave --no-loop ^
  --window-start 6 --frames 24
```

### 5. 从已抽好的图片序列生成

```bat
run_pipeline.bat --from-frames <已抽帧目录> --avatar whale_chibi --action happy ^
  --no-loop --frames 36
```

## 参数速查

| 参数 | 默认 | 说明 |
|---|---|---|
| `--video` | — | 绿幕视频路径（与 `--from-frames` 二选一） |
| `--from-frames` | — | 已抽好的 jpg/png/webp 图片序列目录 |
| `--avatar` | 必填 | 形象 id，例如 `whale_chibi` |
| `--action` | 必填 | 动作 id，例如 `idle` / `wave` / `happy` |
| `--label` | 动作 id | 显示名 |
| `--description` | 留空 | 动作内容描述（面向大模型/UI；单行 ≤200 码点） |
| `--note` | 自动生成 | 制作备注（来源视频与参数） |
| `--fps` | 12 | 目标帧率 |
| `--frames` | 36 | 期望帧数；素材不足时取全部 |
| `--max-frames` | 240 | 最多解码帧数，防止长视频吃内存 |
| `--start` / `--end` | — | 视频起止秒 |
| `--loop` / `--no-loop` | 沿用动作设置；新动作默认单次 | 循环 / 单次 |
| `--window-start` | 自动 | 手动窗口起始帧（0-based） |
| `--canvas` | `768x1024` | 输出画布 |
| `--foot-line` | 980 | 脚底基准 y |
| `--target-height` | 800 | 角色目标高度上限 |
| `--margin` | 24 | 左右安全边距 |
| `--quality` / `--method` | 82 / 4 | WebP 质量与编码 method |
| `--dry-run` | 关 | 只输出预览 PNG |
| `--library-root` | `tools/seq_asset_tool/../../assets/pet_seq` | 覆盖资产库根目录（测试隔离用） |
| `--json` | 关 | 最后输出一行 `SEQ_PIPELINE_RESULT={...}`，供工作台/脚本解析 |

## 流水线做了什么

1. **解码**：按目标 fps 取样，默认 12fps；
2. **色键**：`G - max(R,B)` 软阈值 alpha、形态学清理、连通域过滤、去绿溢；
3. **选窗**：headHold / tailHold（首尾回到站姿）+ 动作量（轮廓 + 画面变化）
   - 抖动 / 裁切 / 高度突变；
4. **循环接缝**：渲染后按 `seamRatio` 判断接缝运动量是否接近正常帧间运动，
   必要时去首/去尾帧；
5. **统一画布**：预乘 alpha 缩放、脚底基准、头部中心/脚底趋势去抖；
6. **写库**：WebP 编码到 `.staging`，旧动作整组移入 `.trash/<时间戳>/<形象>/<动作>`，
   再原子替换；帧数不变时保留动作目录 `config.json` 的逐帧时长倍数与动作元数据，帧数变化则把倍数重置为全 1；
7. **manifest**：新增/更新动作元数据（label / description / loop / fps / runtime / note）；
8. **日志**：每次生成写 `assets/pet_seq/.pipeline/<时间戳>-<形象>-<动作>.json`。

## 素材与 prompt 约定

- 视频模型：Seedance 2.5 图生视频（首尾帧），4s、720p、9:16、无音频；
- **首帧与末帧传同一张基础帧**（`first_frame_url` = `last_frame_url`）；
  只传首帧会让末帧漂移，循环接缝无法保证；
- 背景：纯平 `#00FF00` 绿幕，无渐变、阴影、地面、文字、水印；
- 机位固定，角色全程完整在画面内，位置与大小不变；
- 时间结构：开头 0.5s 与结尾 0.5s 保持同一站姿，中间 3s 完成动作；
- 循环动作（idle）建议在 prompt 里明确「只眨一次眼」「首尾姿态一致」，
  否则模型容易在 4s 内眨眼 2–3 次，loop 时观感会变差；
- 单帧输出统一为 `768×1024` RGBA WebP，命名 `frame_###.webp`；
- 动作的总体内容描述同时写入 manifest 的 `actions[].description` 与动作目录 `config.json`
  （可用 `--description` 传入），与 `config.json` 的逐帧时长同文件维护。

## 安全与回滚

- 资产库旧帧不物理删除，统一进 `assets/pet_seq/.trash`；
- manifest 每次保存前在 `.trash/manifest/` 留一份；
- 建议先 `--dry-run` 看预览，再正式写库。
