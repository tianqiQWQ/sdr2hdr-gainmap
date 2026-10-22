# 开发与测试

## 环境要求

- Node.js 20+（测试脚本）
- Chrome / Chromium（headless 测试用；macOS 默认路径 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，可用环境变量 `CHROME_PATH` 覆盖）
- Python 3.10+，并安装 Pillow、numpy（仅校验/测试图生成需要）

```bash
npm install          # 安装 puppeteer-core（仅开发测试用）
pip install pillow numpy
```

## 生成测试图

仓库不包含任何第三方图片，测试图全部程序化生成：

```bash
python3 tools/make_test_images.py
# 生成 tests/input_synthetic_12mp.jpg（4000×3000，大光比）
#      tests/input_synthetic_48mp.jpg（8000×6000，大图/内存）
#      tests/input_skin.jpg（人像肤色测试）
```

## 编码测试（headless Chrome）

```bash
# 基础：单张图、默认参数
node tools/test_encode.js '[{"input":"tests/input_synthetic_12mp.jpg","strength":50,"output":"tests/out.jpg"}]'

# 完整参数（含整体曝光）
node tools/test_encode.js '[{
  "input":"tests/input_synthetic_12mp.jpg",
  "params":{"strength":50,"knee":170,"detail":40,"color":85,"curvePow":1.6,
            "detailRadius":16,"clarity":15,"portrait":true,"portraitStrength":50,
            "gainScale":1,"exposureEv":1.2,"highlightCompress":80},
  "output":"tests/out_exp.jpg"
}]'
```

## 校验输出

```bash
# 普通 JPG 模式（会检查底图逐字节保留）
python3 tools/validate_output.py \
  --output tests/out.jpg --original tests/input_synthetic_12mp.jpg \
  --strength 50 --knee 170 --pow 1.6 --detail 40 --color 85 \
  --detail-radius 16 --clarity 15

# 整体曝光模式（底图重编码）
python3 tools/validate_output.py \
  --output tests/out_exp.jpg --original tests/input_synthetic_12mp.jpg \
  --strength 50 --exposure-ev 1.2 --clarity 15

# PNG 输入（底图被转成 JPEG，用 --base-reencoded）
python3 tools/validate_output.py \
  --output tests/out.png.jpg --original tests/input.png \
  --strength 50 --base-reencoded

# 参考文件解码（检查解码公式：可选，需要外部 HDR 参考文件）
python3 tools/validate_output.py --decode path/to/reference-ultrahdr.jpg
```

校验分四层：容器结构（MPF/XMP/偏移）、元数据、原图/底图保留、像素与合成曲线一致性。

## UI 端到端测试

```bash
# 上传 → 调参 → 大图调试 → 导出 → 回读
node tools/test_ui.js tests/input_synthetic_12mp.jpg

# 非 macOS 指定浏览器路径
CHROME_PATH=/usr/bin/google-chrome node tools/test_ui.js tests/input_synthetic_12mp.jpg
```

截图会写到 `tests/` 下（已在 `.gitignore` 中忽略）。脚本最后还会把导出的 HDR 图再次上传，验证"已含增益图输入会被拒绝"的回归。

## 项目约定

- **版本号与更新说明**：每次版本更新，页面 `<h1>` 的版本号下方固定显示一行小字说明本次改进；同步更新 `CHANGELOG.md`
- 单文件原则：`index.html` 不引入任何外部依赖/CDN，保证离线双击可用
- 不提交第三方素材：测试图由脚本生成；截图需来自程序化生成内容
- 提交前建议跑一遍：`npm run check`、编码测试、`validate_output.py`

## 发布流程（维护者）

1. 更新 `index.html` 内的版本号与更新说明、`CHANGELOG.md`、`package.json` 版本
2. 构建分享包 zip（`index.html` + 使用说明 + 程化生成的 HDR 样张），作为 GitHub Release 附件
3. 打 tag（如 `v0.7`）并发布 Release
4. 确认 GitHub Pages 已开启（仓库 Settings → Pages → Deploy from branch: `main` / root）
