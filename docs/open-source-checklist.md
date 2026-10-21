# 开源发布前检查清单（open-source-checklist）

本仓库（2D 形象资产规范库与工具集）作为独立 GitHub 仓库发布前的逐项检查与清理记录。

> **路径说明（2026-10-21 目录整理）**：资产库已迁到 `assets/pet_seq/`，资产工作台已迁到 `tools/seq_asset_tool/`。
> 本文第 5–7 节是整理前的历史记录，其中的 `pet_seq/...` / `seq_asset_tool/...` 分别对应当前的 `assets/pet_seq/...` / `tools/seq_asset_tool/...`。

## 1. 许可确认

- [x] 根 `LICENSE`：双许可说明（代码/脚本 MIT；美术素材 CC BY-NC 4.0），并指向两份全文；
- [x] `LICENSE-MIT`：MIT 标准全文（版权人：ZHILING contributors）；
- [x] `LICENSE-CC-BY-NC-4.0`：CC BY-NC 4.0 官方英文全文；
- [x] **已决策（2026-10-21）**：`assets/whale_gril/` 全部历史素材（原始图 `full-res/`、`featured/`、`share-1600/`、`chibi_seq/` 帧）**不随本仓库发布**；其上游为第三方仓库 [AATINF/deepseek-whale-girl-assets](https://github.com/AATINF/deepseek-whale-girl-assets)，授权口径沿用上游，该目录仅本地保留并已加入 `.gitignore`；
- [ ] **仍需人工确认**：`assets/pet_seq/whale_chibi/` 帧由上述素材派生（`import_legacy_assets.py`），随本仓库以 CC BY-NC 4.0 发布前，需确认与上游素材授权口径一致。

## 2. 素材授权与派生关系

- [x] `assets/pet_seq/manifest.json` 的 `origin` 已从本机绝对路径改为相对路径 `../whale_gril/chibi_seq/frames`（相对 `assets/pet_seq/`）；
- [x] `assets/whale_gril/chibi_seq/meta/actions.json` 的 `source` 已改为相对路径 `../../full-res/C17.png`；
- [x] **说明**：`assets/whale_gril/chibi_seq/meta/actions.json` 中「以 C17.png 为唯一角色基准」的说明仅作用于本地历史素材工作区；该目录不随仓库发布，不影响本仓库许可文本。

## 3. 嵌套 Git 仓库

- [x] **已决策（2026-10-21）**：`assets/whale_gril/.git` 是嵌套仓库（历史素材工作区的独立版本库，上游 `AATINF/deepseek-whale-girl-assets`）。**不采用 submodule，也不纳入本仓库**：整个 `assets/whale_gril/` 已由 `.gitignore` 排除，本地保留其独立版本库。

## 4. 大文件与体积

- [x] **已决策（2026-10-21）**：`assets/whale_gril/full-res/`（93 张 PNG）、`share-1600/`、`featured/`、`chibi_seq/` 等大素材**不随本仓库发布**（`.gitignore` 排除）；如需对外提供，另行发布 Release 附件或独立素材仓；
- [x] `examples/whale_chibi_demo.zip`（约 5.3 MB，idle 35 帧 + wave 36 帧 + thumb.png）**随仓库入库**，用户可直接下载导入（`.gitignore` 不忽略示例 zip）。

## 5. 清理记录（2026-10-21 执行）

以下内容已物理删除，删除前全部打包备份到**仓库外**：

- **备份路径**：仓库外的同级目录 `../2d_models_cleanup_backup_2026-10-21.zip`（即仓库根上一层的同名 zip，约 66.5 MB，146 个条目，保持相对路径结构）

| 删除项 | 条目数 | 大小 |
|---|---|---|
| `pet_seq/.trash`（编辑删除的旧帧） | 39 | 2,637,822 B |
| `pet_seq/.source-backup`（源码移除备份；该功能已下线） | 39 | 2,637,822 B |
| `pet_seq/.staging`（视频上传暂存） | 1 | 0 B |
| `seq_asset_tool/pip`（pip 缓存） | 69 | 67,706,542 B |
| `seq_asset_tool/seq_pipeline/__pycache__` | 7 | 79,802 B |
| `assets/whale_gril/chibi_seq/tools/__pycache__` | 1 | 29,308 B |
| `seq_asset_tool/.server.err.log` / `.server.out.log` | 2 | 248 B |

- 删除前先停掉了占用日志文件的 `seq_asset_tool` 本地服务进程（`node server.mjs --no-open`，PID 24328）；
- 未删除任何最终资产：`pet_seq/whale_chibi/**`、`pet_seq/manifest.json`、`pet_seq/README.md`、`seq_asset_tool/` 源码、`assets/whale_gril/**` 均保持原样；
- `.gitignore` 已加入对应模式（`__pycache__/`、`*.pyc`、`.trash/`、`.staging/`、`pip/`、`*.log`、`.DS_Store`、`Thumbs.db`），防止日后误入库。

## 6. 敏感信息 / 本机路径扫描

- [x] 已扫描 `.md` / `.json` / `.py` 等文本文件（排除 `assets/whale_gril/.git`）中的本机绝对路径模式（盘符开头、用户目录开头等）并全部改写为相对路径或占位符：
  - 根 `README.md`、`pet_seq/README.md`、`seq_asset_tool/README.md`、`seq_asset_tool/seq_pipeline/README.md`；
  - `pet_seq/manifest.json`、`assets/whale_gril/chibi_seq/meta/actions.json`、`assets/whale_gril/chibi_seq/preview/index.html`；
- [x] 已下线「同步到知令源码」功能：`pet_seq/` 不再包含 `sync.config.json` / `sync.config.example.json`，
  工具与文档只保留「打包成资产包」的交付路径；
- [x] **发布前复核（2026-10-21）**：在仓库根执行盘符绝对路径、用户目录、敏感凭据模式（`ghp_` / `sk-` / `AKIA` / 私钥头）扫描；仅 `docs/import-to-zhiling.md` 含通用占位示例 `C:\Users\<用户名>\.zhiling`，无真实本机路径与凭据。

## 7. 仓库体积（清理后）

- 随仓库发布内容（排除 `assets/whale_gril/`）：约 **44 MB / 420 个文件**；
- 本地全量（含 `assets/whale_gril/` 与嵌套 `.git`）：约 **1,795 MB / 2,206 个文件**；
- 主要体积来源：`assets/pet_seq/whale_chibi/`（约 38.5 MB，正式帧）、`examples/whale_chibi_demo.zip`（约 5.3 MB）、`assets/whale_gril/`（约 1,366 MB，历史素材，**不入库**）；
- `assets/whale_gril/` 的裁剪决策见第 4 节。
