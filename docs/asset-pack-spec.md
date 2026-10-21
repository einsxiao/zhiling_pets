# 知令 2D 形象资产包规范（作者手册）

本文档面向**想要为知令桌宠制作自定义 2D 形象**的作者，定义「2D 形象包」（以下简称「包」）的完整契约。

本规范的**校验规则真源**是知令桌面端主进程的导入器实现：

- `pet_frame_import.js` —— zip / 目录导入、限额、zip-slip 安全、manifest 定位；
- `pet_frame_registry.js` —— manifest / 动作帧集合 / config.json 动作配置归一化（运行时扫描口径）。

仓库内附带的标准库工具 `tools/pack_2d_frames.py` 与上述实现同口径，可在发布前自检（用法见 [packing.md](packing.md)）。

---

## 1. 总览

一个包 = **一个 zip 文件**，承载**一个形象**的全部运行时数据：

```text
whale_chibi_demo.zip                    # zip 根即形象
├── manifest.json                       # 必填：形象与动作元数据
├── thumb.png                           # 可选：缩略图（缺省回退 idle 首帧）
├── idle/                               # 动作目录（idle 必填）
│   ├── frame_000.webp
│   ├── frame_001.webp
│   ├── ...
│   └── config.json                     # 动作元数据 + 逐帧时长倍数
└── wave/                               # 其余动作可选
    ├── frame_000.webp
    └── ...
```

> 作者侧的 `base/`（基础帧 `frame_000.webp` + 原画 `artwork.png`）不进入资产包；
> 打包工具会跳过它。包内只需要运行时帧、动作 `config.json` 与缩略图。

导入知令后，包会以 `user_2d_<id>` 目录名落到 `<数据根>/pet_assets/2D_FRAMES/` 下，运行时只播放 `idle`（循环）与 `wave`（单次）；其余动作只入库保存、不播放（属储备资产）。

## 2. 硬性限额（超出即拒绝导入）

| 项目 | 上限 |
|---|---|
| zip 文件大小 | ≤ 128 MB |
| zip 条目数（含目录条目） | ≤ 2000 |
| 单条目解压后大小 | ≤ 8 MB |
| 解压后总大小 | ≤ 256 MB |
| 单动作帧数 | ≤ 600 |
| 扩展名白名单 | 仅 `.json` `.webp` `.png` `.md` `.txt` |

> 目录来源导入（`importFrameDir`）同样适用条目数 / 单文件 / 总量限额；目录中白名单外的文件会被静默跳过（不会进入包），打进 zip 则会直接导致 `unsafe_entry` 拒绝。

## 3. 安全规则（zip-slip 防护）

以下条目名一律拒绝，整个包无法导入：

- 空条目名、含空字节 `\0`；
- 含反斜杠 `\`、含盘符（如 `C:`）、以 `/` 开头的绝对路径；
- 路径组件为 `..`、`.` 或空组件（`a//b`）；
- `.DS_Store`、`__MACOSX` 开头的条目；
- 符号链接（zip 内不支持）——请确保打包工具不写入链接条目；
- 扩展名不在白名单内的**任何**条目（如 `.jpg`、`.gif`、`.mp4`）。

> 提示：macOS 打包时先删除 Finder 生成的 `.DS_Store` 与 `__MACOSX`；用本仓库 `tools/pack_2d_frames.py --pack` 打包会自动拒绝这些文件。

## 4. manifest.json

### 4.1 顶层字段

```json
{
  "schemaVersion": 1,
  "kind": "2d_frames",
  "id": "whale_chibi",
  "name": "Q 版鲸鱼娘",
  "canvas": [768, 1024],
  "defaultFps": 12,
  "thumbnail": "thumb.png",
  "license": { "name": "CC BY-NC 4.0", "url": "https://creativecommons.org/licenses/by-nc/4.0/" },
  "origin": { "author": "ZHILING contributors", "homepage": "https://github.com/<your-repo>" },
  "createdAt": "2026-10-20T12:00:00.000Z",
  "actions": [ ... ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `schemaVersion` | 是 | 必须为 `1`，否则拒绝（`invalid_manifest`） |
| `kind` | 否 | 建议写 `"2d_frames"`（导入落盘时由知令补写） |
| `id` | 否 | 形象标识，须匹配 `^[a-z0-9_-]{1,32}$`；缺省时按 `name` → 文件名生成目录 id |
| `name` | 是 | 形象名，非空、≤ 64 码点，否则拒绝（`invalid_manifest`） |
| `canvas` | 否 | `[宽, 高]` 有限正整数，非法/缺省时为 `null`（建议填写，如 `[768, 1024]`） |
| `defaultFps` | 否 | 1–60，缺省 `12`；越界/非法时回退 12（动作缺省 fps 也用它） |
| `thumbnail` | 否 | 包内相对路径，仅 `.png` / `.webp`；禁止绝对路径、盘符、`..`、空组件；文件缺失或非法时回退 `idle/frame_000.<ext>` |
| `license` | 否 | 仅接受对象（如 `{name, url, text?}`），否则置 `{}` |
| `origin` | 否 | 仅接受对象（如作者、来源主页等），否则置 `{}` |
| `createdAt` | 否 | 仅接受字符串（ISO 8601），否则置空 |
| `actions` | 是 | 动作数组，必须包含 `idle`，否则拒绝（`missing_idle`） |

### 4.2 actions[] 条目

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 动作 id，须匹配 `^[a-z0-9_-]{1,32}$`；`idle` 必需，`wave` 可选（运行时接入的两个动作）；数组内不得重复 |
| `label` | 否 | 显示名，字符串 ≤ 32 码点（超长截断） |
| `description` | 否 | **动作内容描述**：一句话说明这个动作整体在做什么、幅度/节奏与首尾姿态，供大模型选择动作与生成播报使用；单行字符串，建议 30–80 字，≤ 200 码点（超长截断），缺失/非法时为空串 |
| `dir` | 否 | 动作目录名，缺省 = `id`；提供时须匹配同一正则 |
| `fps` | 否 | 1–60，缺省用 `defaultFps`，再缺省 12；越界时归一/回退 |
| `loop` | 否 | 布尔；缺省时 `idle=true`、其余 `false` |

> 动作目录存在 `config.json` 时，其中同名字段（`label` / `description` / `fps` / `loop` / `note`）
> 优先于 manifest 的 `actions[]`；打包与导入会以 `config.json` 为准，并把结果写回归一化 manifest。

```json
"actions": [
  {
    "id": "idle", "label": "待机", "dir": "idle", "fps": 12, "loop": true,
    "description": "待机循环：身体随呼吸轻微起伏，只眨一次眼，侧发与鲸鱼尾巴轻摆；幅度小、节奏慢；首尾均为正面站姿。"
  },
  {
    "id": "wave", "label": "挥手", "fps": 12, "loop": false,
    "description": "右手从身侧抬到肩高，手掌张开左右挥动两次后放回身侧；左手自然下垂，双脚不动，首尾均为正面站姿。"
  },
  {
    "id": "happy", "label": "开心", "fps": 12, "loop": false,
    "description": "双手同时向上举起，原地轻轻跳起一次后落地，露出笑容；尾巴随身体上扬，首尾均为正面站姿。"
  }
]
```

## 5. 帧文件

- 命名：`frame_%03d`（3 位）或 `%04d`（4 位）序号 + `.webp` / `.png`，即 `frame_000.webp` … `frame_599.webp`；
- 序号**必须从 000 连续**、无缺号；同一动作内**扩展名与序号位宽必须一致**；
- 形似帧文件但命名不合规（`frame_0.webp`、`frame_000.jpg`、`FRAME_000.webp`、`frame_00000.webp`）→ 整个动作拒绝（`invalid_frames`）；
- 动作目录内其它文件（`config.json`、旧版 `timing.json`、`README.md` 等）不参与帧校验；
- 数量：单动作 1–600 帧；**`idle` ≥ 2 帧**（不足拒绝）；
- 图片内容建议：RGBA、透明底、`canvas` 尺寸（示例形象为 `768×1024`）；解码由渲染端负责，导入侧不校验图像二进制。

## 6. config.json（动作目录，可选）

位于动作目录内，**同时承载动作语义与逐帧时长**：

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

- **动作元数据**：`id` / `label` / `description` / `fps` / `loop` / `note`，与 manifest 的
  `actions[]` 同口径；读取时以 `config.json` 为准，缺失字段回退 manifest。
- **逐帧时长**：`frameMultipliers` 支持两种形态：
  - **对象键**（推荐）：键为帧文件名，值为 0.1–20 的倍数，缺项 = 1；
  - **数组**（旧式）：按帧序，多截少补；
- 实际单帧停留 = `1000 / baseFps × 倍数`（缺省 1 倍）；
- 非法 / 越界值会被静默归一（0.1–20、三位小数），文件损坏或非对象时整体忽略（全 1）。
- 旧版 `timing.json` 仍可读取（`config.json` 不存在时回退），但新资产必须写 `config.json`；
  两者同时存在时以 `config.json` 为准。

> `config.json` 是动作级真源：动作整体在做什么（`description`）与每帧停多久
> （`frameMultipliers`）放在同一个文件里，避免制作时漏改其中一处。
> 制作流程与描述写法见 [action-production-guide.md](action-production-guide.md)。

## 7. thumb.png（可选）

- 包根 `thumb.png`（或 `thumb.webp`），作为形象卡片缩略图；
- 缺省回退 `idle/frame_000.<ext>`；两者都不可用则缩略图为空（不影响播放）。

## 8. 目录来源导入（可选方式）

知令同时支持**目录来源**导入（设置页「扫描资产库文件夹…」）：

- 目录自身含 `manifest.json` → 按包导入（zip 导入同口径校验）；
- 目录无 `manifest.json` 但其**父目录** `manifest.json` 含 `avatars[]` 且条目 `id` 等于目录名（即本仓库 `assets/pet_seq/` 库结构）→ 自动合成单形象 manifest 后导入，仅取目录中实际存在的动作目录；
- 源目录不会被移动，导入复制白名单文件。

## 9. 常见错误码对照表

错误码来自 `pet_frame_import.js`（导入器）与 `pet_frame_registry.js`（注册表）：

| 错误码 | 含义 | 常见原因 |
|---|---|---|
| `invalid_payload` | 入参非法 | 缺少 filePath / 源不是普通目录 |
| `file_not_found` | 文件/目录不存在 | 路径错误 |
| `read_failed` | 读取失败 | zip 损坏、权限问题 |
| `file_too_large` | 超出限额 | zip >128MB / 单条目 >8MB / 总量 >256MB |
| `too_many_entries` | 条目数超限 | zip 条目 >2000 |
| `unsafe_entry` | 条目不安全 | 绝对路径 / `..` / 反斜杠 / 非白名单扩展名 / `.DS_Store` / `__MACOSX` |
| `missing_manifest` | 找不到 manifest | 根或单层包裹目录无 `manifest.json` |
| `invalid_manifest` | manifest 非法 | `schemaVersion`≠1、`name` 缺失/超长、`actions` 非数组、`id`/`action.id`/`dir` 不合白名单 |
| `invalid_actions` | 动作条目非法 | 动作不是对象、id 重复 |
| `missing_idle` | 缺 idle | `actions` 中没有 `idle` |
| `invalid_frames` | 帧集合非法 | 命名不合规、缺号、idle<2、>600、扩展名/位宽不一致 |
| `write_failed` | 落盘失败 | 目标目录已存在、磁盘错误 |
| `not_found` / `remove_failed` | 移除目标不存在/失败 | 移除用 |
| `data_root_unavailable` | 数据根不可用 | 数据目录解析失败 |

> 导入成功后知令会落盘一份**归一化 manifest**（补 `id` / `kind` / `source` / `sha256` / `bytes` / `createdAt` / `origin.fileName`，actions 补 `frames` / `naming` / `ext` / `multipliers`），注册表与运行时消费的是这份归一化结果。

## 10. 快速自检

```bash
# 目录校验（含 assets/pet_seq 库结构：无自身 manifest 时自动读父目录 avatars[]）
python tools/pack_2d_frames.py --validate <你的形象目录>

# 打包
python tools/pack_2d_frames.py --pack <你的形象目录> --out <你的包>.zip

# 包校验
python tools/pack_2d_frames.py --validate <你的包>.zip
```

校验输出分「错误 / 警告」两级：错误 = 知令会拒绝导入；警告 = 可导入但会被静默归一/回退（建议处理）。
