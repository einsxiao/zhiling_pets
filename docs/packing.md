# 打包与校验工具：tools/pack_2d_frames.py

零依赖的打包 / 校验工具（Python 3 标准库，无需 pip 安装任何包），校验口径与知令桌面端导入器
（`pet_frame_import.js` / `pet_frame_registry.js`）**严格一致**。

```bash
python tools/pack_2d_frames.py --help    # 完整中文说明
```

## 1. 命令一览

| 用法 | 作用 |
|---|---|
| `--validate <目录\|zip>` | 校验 2D 形象包（目录或 zip），输出错误/警告分级问题清单；退出码 0=通过，1=失败 |
| `--pack <目录> --out <zip>` | 把**目录内容**（不是目录本身）打包为 zip |
| `--actions idle,wave` | 只打包清单中的动作（逗号分隔；缺省打包全部动作；仅配合 `--pack`） |
| `--thumb <图片>` | 用指定图片覆盖包内 `thumb.png` / `thumb.webp`（png/webp） |

## 2. 示例

```bash
# 校验 assets/pet_seq 库结构下的形象目录（目录无自身 manifest.json 时，
# 自动读父目录 manifest.json 的 avatars[] 条目合成单形象 manifest）
python tools/pack_2d_frames.py --validate assets/pet_seq/whale_chibi

# 打包全部动作
python tools/pack_2d_frames.py --pack assets/pet_seq/whale_chibi --out examples/whale_chibi_demo.zip

# 只打包 idle + wave，并覆盖缩略图
python tools/pack_2d_frames.py --pack assets/pet_seq/whale_chibi \
  --actions idle,wave \
  --thumb assets/pet_seq/whale_chibi/thumb.png \
  --out examples/whale_chibi_demo.zip

# 校验产物
python tools/pack_2d_frames.py --validate examples/whale_chibi_demo.zip
```

## 3. 打包行为

- 输出 zip 的**根即形象**：包含归一化的 `manifest.json`、所选动作目录的帧文件与
  `config.json`、缩略图（`thumb.png`/`thumb.webp`）；`base/`（基础帧/原画）只留在作者侧，不打包；
- 条目路径统一使用 `/`；不写入目录条目（减少条目数）；
- **拒绝写入** `__MACOSX`、`.DS_Store`、`Thumbs.db`（任意层级，跳过并警告）；
- 跳过白名单（`.json/.webp/.png/.md/.txt`）之外的文件并警告（这些文件打进 zip 会导致知令拒绝导入）；
- `--actions` 指定的动作不存在于 manifest 时报错退出；
- 打包前校验所选动作的帧集合（`idle`≥2、连续、扩展名/位宽一致、≤600 帧），失败拒绝打包；
- 打包后自动对产物做一次完整 zip 校验（含限额），任何错误都会报出。

## 4. 校验规则（与知令导入器同口径）

**manifest**：`schemaVersion`=1；`name` 非空 ≤64 码点；`actions` 数组且必含 `idle`；
`id` / `action.id` / `dir` 匹配 `^[a-z0-9_-]{1,32}$`；`fps` 1–60（缺省 defaultFps→12）；
`label` ≤32；`description` 可选单行文本 ≤200 码点（超长截断）；`canvas` 正整数对（可空）；`thumbnail` 相对 png/webp 路径。

**帧文件**：`frame_%03d|%04d.webp|png`；序号从 `000` 连续；同动作扩展名与位宽一致；
单动作 ≤600；`idle` ≥2；`frame_` 前缀但命名不合规直接判错。

**config.json**（动作目录，可选）：承载 `label` / `description` / `fps` / `loop` / `note`
与 `frameMultipliers`；`frameMultipliers` 支持对象键 / 数组，0.1–20，三位小数，缺省 1。
非法值导入器会静默归一 → 工具给**警告**；旧版 `timing.json` 仍可读取但会提示迁移。

**限额**：zip ≤128MB、条目 ≤2000、单条目 ≤8MB、总量 ≤256MB。

**安全**：拒绝空字节 / 反斜杠 / 盘符 / 绝对路径 / `..` / `.` / 空组件 / `.DS_Store` / `__MACOSX`。

**manifest 定位**：zip 根 `manifest.json`，或单层包裹目录自动下钻（`<目录>/manifest.json`）。

## 5. 输出解读

```text
[错误] invalid_frames：帧序号必须从 000 连续无缺号（第 12 位期望 012，实际 frame_013.webp）
[警告] 动作 'happy' 的 label 超过 32 码点，将被截断
=== 校验 my_avatar：失败（1 个错误，1 个警告）===
```

- **错误**：知令会拒绝导入，必须修复（退出码 1）；
- **警告**：知令可导入，但字段/文件会被静默归一、回退或跳过（退出码仍为 0），建议处理后再发布。
