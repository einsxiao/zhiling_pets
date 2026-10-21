# 知令（ZHILING）2D 形象资产规范库与工具集

为知令桌宠提供 **2D 形象资产规范、打包/校验工具、官方示例包与资产工作台** 的开源仓库。
用户可依据规范制作自定义桌宠形象，通过知令桌面端设置页一键导入。

- **快速起步** → [2D形象制作指导手册.md](2D形象制作指导手册.md)（目录契约、config.json、基础帧、制作流程、智能体清单）
- 制作动作序列帧 → [docs/action-production-guide.md](docs/action-production-guide.md)（基础帧首尾对齐 → Seedance 2.5 绿幕视频 → 抽帧入库）
- 制作自己的资产包 → [docs/asset-pack-spec.md](docs/asset-pack-spec.md)（作者手册）
- 把资产包装进知令 → [docs/import-to-zhiling.md](docs/import-to-zhiling.md)（用户手册）
- 打包/校验工具 → [docs/packing.md](docs/packing.md)
- 官方示例包 → [examples/whale_chibi_demo.zip](examples/whale_chibi_demo.zip)

## 目录结构

```text
zhiling_pets/
├── assets/                     # 内容资产
│   ├── pet_seq/                # 规范资产库（唯一真源：manifest + 各形象/动作帧）
│   └── whale_gril/             # 鲸鱼娘历史素材与生成工作区（仅本地保留，不随仓库发布）
├── docs/                       # 规范与使用文档
├── examples/                   # 合规示例包
├── tools/                      # 工具
│   ├── pack_2d_frames.py       # 2D 帧包打包/校验
│   └── seq_asset_tool/         # 资产工作台 + 绿幕视频流水线
├── 2D形象制作指导手册.md
├── 启动工具.bat
└── LICENSE*（MIT + CC BY-NC 4.0）
```

| 路径 | 说明 |
|---|---|
| `2D形象制作指导手册.md` | **制作与智能体协作手册**：目录契约、config.json、基础帧、制作流程、质检清单 |
| `启动工具.bat` | Windows 根目录快速启动器：调用 `tools\seq_asset_tool\start.bat` 打开资产工作台 |
| `docs/` | 规范与使用文档（作者手册 / 导入手册 / 打包工具 / 开源清单） |
| `tools/pack_2d_frames.py` | 2D 帧包打包/校验工具（Python 3 标准库，零依赖；口径与知令导入器一致） |
| `tools/seq_asset_tool/` | 本地 HTML 资产工作台（预览/插帧/删帧/逐帧时长/视频生成）与 `seq_pipeline/` 绿幕视频流水线 |
| `examples/` | 合规示例包 `whale_chibi_demo.zip`（idle + wave + thumb）及说明 |
| `assets/pet_seq/` | 规范资产库：`manifest.json`（形象/动作元数据）与 `whale_chibi/` 正式帧 |
| `assets/whale_gril/` | 鲸鱼娘历史素材与生成工作区（**仅本地保留，不随本仓库发布**；上游为第三方素材仓库，见 [开源清单](docs/open-source-checklist.md)） |

## 快速开始

```bat
REM 0. 启动资产工作台（Windows）
启动工具.bat
```

```bash
# 1. 准备帧：按规范整理形象目录（idle 必填，frame_000.webp 起连续编号）
my_avatar/
├── manifest.json          # 必填，见 docs/asset-pack-spec.md
├── thumb.png              # 可选
├── base/frame_000.webp    # 建议：基础帧（所有动作首尾参照）
├── idle/frame_000.webp ...# idle ≥2 帧
├── idle/config.json       # 动作元数据 + 逐帧时长
└── wave/frame_000.webp ...# 可选动作
```

```bash
# 2. 校验 + 打包
python tools/pack_2d_frames.py --validate my_avatar
python tools/pack_2d_frames.py --pack my_avatar --out my_avatar.zip
```

```
# 3. 知令导入：设置 → 桌面宠物 → 「导入 2D 帧包…」选择 my_avatar.zip
```

## 文档索引

| 文档 | 面向 | 内容 |
|---|---|---|
| [2D形象制作指导手册.md](2D形象制作指导手册.md) | 作者 / 智能体 | **总入口**：目录契约、config.json、基础帧、制作流程、质检与智能体操作清单 |
| [docs/action-production-guide.md](docs/action-production-guide.md) | 作者 | **动作参考制作流程**：基础帧首尾对齐、Seedance 2.5 4s 绿幕视频、抽帧选窗、入库与质检 |
| [docs/asset-pack-spec.md](docs/asset-pack-spec.md) | 作者 | 包结构、manifest/actions 字段（含 `description`）、帧命名、动作 config.json、限额、安全规则、错误码表 |
| [docs/import-to-zhiling.md](docs/import-to-zhiling.md) | 用户 | 资产目录、设置页发现、导入/移除、旧 pet_models 迁移、常见问题 |
| [docs/packing.md](docs/packing.md) | 作者 | `tools/pack_2d_frames.py` 全部用法与校验输出解读 |
| [docs/open-source-checklist.md](docs/open-source-checklist.md) | 维护者 | 发布前清单：许可、素材授权、嵌套 git、清理记录、路径扫描 |
| [assets/pet_seq/README.md](assets/pet_seq/README.md) | 维护者 | 资产库目录约定与交付方式 |
| [tools/seq_asset_tool/README.md](tools/seq_asset_tool/README.md) | 维护者/作者 | 资产工作台与视频流水线用法 |

## 许可（双许可）

- **代码 / 脚本 / 文档**：[MIT License](LICENSE-MIT)（版权：ZHILING contributors）；
- **美术素材**（`assets/pet_seq/` 帧、`examples/` 示例包）：[CC BY-NC 4.0](LICENSE-CC-BY-NC-4.0)（署名-非商业性使用 4.0）。

详见 [LICENSE](LICENSE)。使用示例包请保留署名。

## 与知令主仓库的关系

- 本仓库是**资产与工具**仓库；知令桌面端（闭源主仓库）内置了与本规范同口径的导入器
  （`pet_frame_import.js` / `pet_frame_registry.js`），本仓库的校验工具与文档以该实现为**真源**保持一致；
- 运行时只播放 `idle`（循环）与 `wave`（单次）；其余动作入库保存、不播放；
- 资产库 `assets/pet_seq/` 是唯一真源；对外交付通过 `tools/pack_2d_frames.py` 打包成资产包，
  由知令设置页导入（工具不向知令源码目录写入帧）。

## 贡献方式

1. 制作/修正资产包：按 [作者手册](docs/asset-pack-spec.md) 完成后用
   `python tools/pack_2d_frames.py --validate <目录|zip>` 自检，欢迎提交 PR 附带示例包；
2. 工具改进：保持与知令导入器同口径（限额/命名/错误码），纯 Python 3 标准库，不引入第三方依赖；
3. 发现规范与知令实现不一致：请在 Issue 中给出最小复现包（脱敏后）与导入错误码。
