# examples/whale_chibi_demo.zip 说明

`whale_chibi_demo.zip` 是本仓库的**官方合规示例包**，由 `tools/pack_2d_frames.py` 从
`assets/pet_seq/whale_chibi/` 组装生成：

```bash
python tools/pack_2d_frames.py --pack assets/pet_seq/whale_chibi \
  --actions idle,wave \
  --thumb assets/pet_seq/whale_chibi/thumb.png \
  --out examples/whale_chibi_demo.zip
```

- 内容：`manifest.json` + `idle/`（35 帧，循环）+ `wave/`（36 帧，单次）+ 各动作 `config.json` + `thumb.png`，共 75 个条目，约 5.3 MB；
- 帧：`768×1024` RGBA WebP，`frame_000.webp` 起连续编号，符合 [asset-pack-spec.md](../docs/asset-pack-spec.md)；
- 许可：美术素材按 [CC BY-NC 4.0](../LICENSE-CC-BY-NC-4.0)，署名 ZHILING contributors；
- 导入：知令「设置 → 桌面宠物 → 导入 2D 帧包…」选择本 zip，导入后 id 为 `user_2d_whale_chibi`；
- 已在知令主进程导入器上实测通过（`importFrameZip` → `ok:true`；注册表确认 idle=35/wave=36、fps=12）。

> 该 zip 随仓库入库（.gitignore 不忽略），便于用户直接下载。重新生成：
> 删除旧 zip 后执行上面的打包命令即可（生成的 manifest 由工具归一化，不要手工改包内文件）。
