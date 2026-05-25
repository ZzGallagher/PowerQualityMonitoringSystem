# 三维模型资源

`AA1.glb` 是网页端实际加载的 AA1 负荷开关柜模型文件。

源文件位于项目根目录 `AA1.blend`。Blender 只在导出时使用，目标运行机器不需要安装 Blender，只需要部署导出的 `AA1.glb`。

如果本机安装了 Blender，可在项目根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\软件2\web\assets\models\export-aa1-glb.ps1
```

脚本会按以下顺序寻找 Blender：

1. 环境变量 `BLENDER_EXE_PATH`
2. 本目录未提交的 `export-aa1-glb.config.json`
3. 常见安装路径，包括 `D:\Program Files\Blender4.0.1(64bit)\blender-4.0.1\blender.exe`
4. PATH 中的 `blender`

可复制 `export-aa1-glb.config.example.json` 为 `export-aa1-glb.config.json` 后修改本机路径。

模型对象命名约定：

- `AA1_C1_LAMP` / `AA1_C1_HANDLE`
- `AA1_C2_LAMP` / `AA1_C2_HANDLE`
- `AA1_C3_LAMP` / `AA1_C3_HANDLE`
- `AA1_C4_LAMP` / `AA1_C4_HANDLE`

当前 `AA1.blend` 源模型使用 `aa2-ct1-btn`、`aa2-ct1-handle` 等对象名；导出脚本会在导出内存副本时重命名为上述稳定对象名，不会改写 `.blend` 源文件。

源模型中的 `Rectangle204` 是大尺寸背景/地面辅助面，会影响网页端相机适配并形成背后阴影；导出脚本会从 GLB 中排除它。
