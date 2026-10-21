# seq_asset_tool — 2D 序列帧资产工作台

本地零依赖的 HTML 工具，用于管理本仓库 `assets/pet_seq/` 中的 2D 序列帧资产：

- 浏览形象 / 动作，按动作播放预览（可调背景、缩放、参考线）；
- 指定位置插入帧、替换帧、删除帧（旧帧移入 `.trash`）、拖拽重排、复制帧；
- 逐帧导航支持首尾循环：末帧「下一帧」回到首帧，首帧「上一帧」跳到末帧；
- 为每个动作逐帧配置时长倍数（默认 1 倍 = 12fps 基准），配置保存在动作目录的 `config.json`；
- 在工作台内直接导入绿幕视频，生成新动作或覆盖当前动作（解码 → 色键 → 选窗 → 统一画布 → WebP 写库）；
- 编辑动作显示名、帧率、循环、**动作描述（供大模型调用）**、制作备注；
- 资产库始终保留全部帧：删除/替换只把旧帧移入 `.trash`，不会物理删除库资产；
- 对外交付统一走 `tools/pack_2d_frames.py` 打包成资产包（工作台不直接写知令源码）。

## 启动

双击 `start.bat`（或在本目录执行）：

```bat
cd tools\seq_asset_tool
start.bat
```

脚本会检查 Node.js（需要 18+）、在前台启动服务，并在服务就绪后自动打开工作台页面。
**按 Ctrl+C 或直接关闭窗口即停止服务**：node 进程运行在该窗口的控制台里，窗口结束服务随之退出；
脚本同时启用了 `--watch-parent`，即使启动窗口被强制结束而 node 短暂存活，也会在 1 秒内自动停服。

> 按下 Ctrl+C 后如果出现 `Terminate batch job (Y/N)?`，输入 `Y` 或 `N` 都可以：此时服务已经停止，只是 cmd 在确认是否结束批处理。

也可以手动启动：

```bash
node server.mjs --open            # 启动并打开页面；Ctrl+C 停止
node server.mjs --watch-parent    # 父进程（启动它的窗口）退出时自动停止
```

浏览器地址：`http://127.0.0.1:4321`。

- 端口上已有工作台在运行时，`start.bat` 会直接打开已有实例（不再顺延到 4322/4323，避免看到旧代码的实例）；
  需要强制新开一个实例时用 `start.bat --force-new`。
- 端口被其它程序占用时仍会自动顺延，实际地址以启动窗口打印的为准。

> 不能直接双击 `index.html`：工作台需要本地服务读写资产库，`file://` 下会提示连接失败。

> `start.cmd` 是兼容旧入口，内部直接转发到 `start.bat`。

## 从绿幕视频生成动作（seq_pipeline）

### 在工作台内导入

右侧「动作」页 →「从绿幕视频生成」→「导入绿幕视频…」，或帧序列工具栏的「导入视频…」：

1. 选择 / 拖入绿幕视频（mp4 / mov / webm / mkv / avi / m4v，≤ 512MB）；
2. 选择「新建动作」（默认，动作 ID 会按视频文件名自动填写并避免重名）或「替换当前动作」；
3. 设置帧数、帧率、循环；需要时展开「高级参数」调整画布、选窗窗口与 WebP 质量；
4. 点「开始生成」，弹窗内会显示上传进度、流水线日志与最终结果（帧数、时长、循环接缝 seamRatio、备份位置）。

工作台会把视频暂存到 `assets/pet_seq/.staging/uploads`（48 小时后自动清理），
通过本地 Python 运行 `seq_pipeline`；生成期间会锁定其他生成任务，可以随时「停止生成」，已写库的旧动作仍有 `.trash` 备份。

### Python 环境（流水线依赖）

导入弹窗底部会显示 Python 环境状态；要求 **Python 3.10+** 以及 `opencv-python` / `numpy` / `Pillow`。

解释器按以下顺序自动探测（不依赖启动时的 PATH，从资源管理器双击也能正常识别）：

1. `SEQ_PYTHON` 环境变量；
2. 工作台里「指定 Python…」保存的路径（`pipeline.env.json`）；
3. 本工具目录的 `.venv`（「安装依赖」创建）；
4. ZHILING 桌面端内置 Python（`~/.zhiling/python-*-embed-*/`，通常已带上述依赖）；
5. 系统 `python` / `py -3` / `python3`。

环境不可用时弹窗内会列出每个候选解释器及缺失的包，并提供三个操作：

- **重新检测**：重新扫描（改过环境变量或装完依赖后使用）；
- **安装依赖（.venv）**：用系统 Python 在本工具目录创建 `.venv` 并 `pip install -r requirements.txt`，
  不影响系统 Python；过程有实时日志，可「停止安装」，完成后自动切换到该环境；
- **指定 Python…**：手动填入解释器绝对路径，保存后立即生效。

也可以手动检查当前解释器：

```bash
python check_env.py     # 输出单行 JSON：可用性、版本、缺失模块
```

### 命令行

工作台同目录提供固定流水线 `seq_pipeline/`，一条命令完成
「视频解码 → 色键 → 选窗 → 统一画布 → WebP 入库 → manifest」：

```bat
cd tools\seq_asset_tool
run_pipeline.bat --video <视频路径>\idle.mp4 --avatar whale_chibi --action idle --loop --frames 36
```

- 先看预览：加 `--dry-run --preview-dir <目录>`，不会改资产库；
- 单次动作：`--no-loop`；手动窗口：`--window-start 6`；
- 图片序列：`--from-frames <目录>`；
- 完整参数与循环接缝处理说明见 `seq_pipeline/README.md`。

## 目录

```
tools/seq_asset_tool/
├── index.html              # 工作台页面
├── styles.css              # 深/浅色主题
├── app.js                  # 前端逻辑（无框架）
├── server.mjs              # 本地服务（Node 内置模块，无 npm 依赖）
├── check_env.py            # 检查流水线依赖（可用性 / 版本 / 缺失模块）
├── requirements.txt        # 流水线依赖（opencv-python-headless / numpy / Pillow）
├── import_legacy_assets.py # 历史 PNG 素材补齐到 assets/pet_seq（一次性/可重复）
├── seq_pipeline/           # 绿幕视频 → 序列帧动作流水线（Python）
├── run_pipeline.bat        # 流水线入口（Windows）
├── run_pipeline.sh / .py   # 流水线入口（Linux/macOS / Python 直接运行）
├── start.bat               # Windows 启动器（启动服务 + 打开页面，关窗 / Ctrl+C 即停服）
├── start.cmd / start.sh    # 兼容旧入口（转发 start.bat）/ Linux、macOS 启动脚本
└── README.md
```

## 常用操作

### 指定位置插入帧

1. 左侧选择动作；
2. 帧条上每个「+」就是插入点（在第 N 帧前）；也可以点「插入帧…」（默认插到当前帧前），
   或在右侧「帧 → 指定位置插入」输入 1-based 位置（`帧数 + 1` = 末尾）；
3. 选择图片（可多选），工具会按「插入适配」缩放/裁切到 `768×1024`，编码为 WebP 后写入资产库。

插入后旧帧整组移入 `assets/pet_seq/.trash/<时间戳>/...`，新序列重新编号为 `frame_000.webp` 起。

### 逐帧时长微调

右侧「帧 → 帧时长」：

- 基准时长为 12fps 的 `83.3ms`；每帧的倍数默认为 `1`，可输入 `0.1–20`；
- `−` / `＋` 每次调整 `0.05` 倍，也可直接输入或「重置」当前帧；
- 「全部帧重置为 1」可清空整个动作的覆盖项；
- 修改后自动保存（约 350ms 防抖），并立即影响工作台预览的逐帧停留时间。

配置文件位于每个动作目录下，例如 `assets/pet_seq/whale_chibi/idle/config.json`：

```json
{
  "schemaVersion": 1,
  "id": "idle",
  "label": "待机",
  "description": "待机循环：身体随呼吸轻微起伏，只眨一次眼，侧发与鲸鱼尾巴轻摆；幅度小、节奏慢；首尾均为正面站姿。",
  "fps": 12,
  "loop": true,
  "note": "呼吸起伏、只眨一次眼、尾巴与侧发轻微摆动。",
  "baseFps": 12,
  "frameMultipliers": {
    "frame_004.webp": 2,
    "frame_005.webp": 1.5
  },
  "updatedAt": "2026-10-21T08:00:00.000Z"
}
```

逐帧倍数只记录非 1 的覆盖项，未列出的帧一律按 1 倍处理；实际时长 = `1000 / baseFps × 倍数`。
插帧、删帧、重排、替换时，工具会同步移动/保留对应倍数；帧数变化时新帧默认 1 倍。

### 动作描述（供大模型调用）

右侧「动作 → 动作描述（供大模型调用）」用于填写动作的**总体内容**，与「制作备注」分开：

- 建议四段式：`<动作意图>：<主要部位 + 运动>；<幅度/次数/节奏>；<其他部位状态>；<首尾姿态>。`
- 单行、建议 30–80 字、上限 200 码点；
- 同时写入动作目录 `config.json` 与 `assets/pet_seq/manifest.json` 的 `actions[].description`，打包时进入包内 manifest；
- 不要写“尚未生成帧”等制作状态（写到「制作备注」）。

`config.json` 同时承载逐帧时长与动作元数据（label / description / fps / loop / note），是动作级真源；`manifest.json` 保留库级索引，工具写入时会同步两者。旧版 `timing.json` 只读兼容，新动作请勿再写。

### 发布为资产包

工作台只负责资产库，**不直接写知令源码**。制作完成后用仓库根目录的
`tools/pack_2d_frames.py` 打包成合规资产包，再由知令的设置页导入：

```bash
python tools/pack_2d_frames.py --pack assets/pet_seq/whale_chibi --out dist/whale_chibi.zip --actions idle,wave
python tools/pack_2d_frames.py --validate dist/whale_chibi.zip
```

- 包内 `manifest.json` 由动作目录的 `config.json` 汇总生成（含逐帧倍数与动作描述）；
- 运行时当前只播放 `idle` 与 `wave`；储备动作可以入库、预览、编辑与打包，但不会自动播放。

## 安全与回滚

- 所有写操作都先写临时目录，再原子替换；失败时尽量恢复旧目录；
- 资产库的旧帧不物理删除，统一进入 `.trash`；
- `manifest.json` 每次保存前会在 `.trash/manifest/` 留一份副本。

## 环境变量（测试/隔离）

| 变量 | 作用 |
|---|---|
| `SEQ_LIBRARY_ROOT` | 覆盖资产库根目录 |
| `SEQ_PYTHON` | 指定绿幕流水线使用的 Python 解释器（优先级最高） |
| `SEQ_PYTHON_CONFIG` | 覆盖 `pipeline.env.json` 路径（工作台保存的指定解释器） |
| `SEQ_VENV_DIR` | 覆盖本工具 `.venv` 目录（安装依赖 / 自动探测用） |
| `SEQ_REQUIREMENTS` | 覆盖 `requirements.txt` 路径（测试用） |
| `SEQ_PORT` / `SEQ_HOST` | 覆盖监听地址 |
| `SEQ_NO_OPEN=1` | 不自动打开浏览器 |

示例：

```bash
SEQ_LIBRARY_ROOT=<临时资产库目录> \
SEQ_PORT=4399 SEQ_NO_OPEN=1 node server.mjs
```
