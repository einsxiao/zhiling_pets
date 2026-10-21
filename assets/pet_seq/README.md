# 2D 形象资产库（assets/pet_seq）

这里是 2D 形象的**规范资产库**，也是唯一需要长期维护的帧资产位置。
（本文中的仓库内路径均相对仓库根；历史素材源 `assets/whale_gril/` 仅本地保留，不随本仓库发布，相关路径仅作溯源记录。）

## 目录约定

```text
assets/pet_seq/
├── manifest.json              # 形象 / 动作索引（avatars[] 库级结构；与动作 config.json 同步）
├── whale_chibi/               # 形象 id
│   ├── thumb.png              # 缩略图（示例包 thumb 来源）
│   ├── base/                  # 所有动作共同遵守的零姿态
│   │   ├── frame_000.webp     # 基础帧（768×1024 RGBA；首帧/末帧参照）
│   │   ├── artwork.png        # 原画大图（1024×1024；设定参考，不参与播放）
│   │   └── README.md
│   ├── idle/                  # 动作 id
│   │   ├── frame_000.webp
│   │   ├── frame_001.webp
│   │   ├── config.json        # 动作元数据 + 逐帧时长倍数（动作级真源）
│   │   └── ...
│   ├── wave/
│   └── ...                    # 其余动作同理
├── .trash/                    # 编辑删除/替换时移入的整组旧帧（不物理删除；不入库）
└── .staging/                  # 写库与视频上传的临时目录（工具维护）
```

- 帧格式：`WebP`（RGBA，透明底），单帧 `768×1024`，命名 `frame_###.webp`，编号连续。
- 动作目录的 `config.json` 是**动作级真源**：`label` / `description` / `fps` / `loop` / `note`
  与 `baseFps` / `frameMultipliers` 同文件维护；`manifest.json` 保留库级索引，工具写入时同步两者。
- 未列出的帧按 1 倍（12fps 基准）处理。旧版 `timing.json` 只读兼容，新资产不要再写。
- `base/frame_000.webp` 是所有动作的首帧/末帧参照；`base/artwork.png` 是原画设定参考。
  基础帧一旦变更，已有动作需整批重做；`base/` 不进入资产包。
- `actions[].description` 是动作的总体内容描述（供大模型选择动作/播报使用），
  与 `note`（制作备注）分开；制作流程见 `docs/action-production-guide.md`。
- `.trash` 与 `.staging` 由工具维护，**不要手动清空**；确认不再需要后再人工处理。
- 面向使用者的资产包规范见 `docs/asset-pack-spec.md`（本目录 avatars[] 条目与包 manifest 字段一一对应）。

## 资产来源

`whale_chibi` 的帧来自 `assets/whale_gril/chibi_seq/frames/<action>`（历史 PNG 抽帧产物），
由 `tools/seq_asset_tool/import_legacy_assets.py` 补齐为 WebP（默认 q=82、method=4；已有帧的动作整体跳过，不覆盖已调整的序列）。
`happy` / `angry` 目前没有历史素材，保持 0 帧，可在工作台选中后插入帧补全。

## 交付方式

- 本资产库是唯一真源，工具不向知令源码目录复制任何帧；
- 对外交付统一用 `tools/pack_2d_frames.py` 打包成资产包（见「打包发布」），由知令设置页导入；
- 运行时当前只播放 `idle`（循环）与 `wave`（单次）；其余动作是储备资产，仅入库与打包。

## 从绿幕视频生成新动作

新动作优先用固定流水线生成，而不是手工抽帧/转 WebP：

```bat
cd tools\seq_asset_tool
run_pipeline.bat --video <视频路径>\happy.mp4 --avatar whale_chibi --action happy --no-loop --frames 36 ^
  --description "开心：双手向上举起，原地轻跳一次后落地，露出笑容；首尾均为正面站姿。"
```

视频统一用 Seedance 2.5 生成：4s、720p、9:16，**首帧与末帧传同一张基础帧**；
完整流程见 `docs/action-production-guide.md`。

流水线会按规范写入 `assets/pet_seq/<avatar>/<action>/frame_###.webp`、更新 `manifest.json`，
旧动作整组备份到 `.trash`。详见 `tools/seq_asset_tool/seq_pipeline/README.md`。

## 管理工具

```bat
cd tools\seq_asset_tool
start.cmd
```

或：

```bash
node server.mjs --open
```

浏览器打开 `http://127.0.0.1:4321`（端口被占用时自动 +1）。

## 打包发布

把某个形象（如 `whale_chibi`）导出为用户可导入的资产包：

```bash
python tools/pack_2d_frames.py --validate assets/pet_seq/whale_chibi
python tools/pack_2d_frames.py --pack assets/pet_seq/whale_chibi --actions idle,wave \
  --thumb assets/pet_seq/whale_chibi/thumb.png --out examples/whale_chibi_demo.zip
```

详见 `docs/packing.md`。
