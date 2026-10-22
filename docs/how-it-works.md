# 工作原理

这份文档说明工具生成的 HDR JPG 是什么结构、参数如何影响增益图，以及为什么某些预览方式看不到 HDR 效果。

## 输出文件结构

输出是一个标准 JPEG 容器，内部包含两张图与若干元数据段：

```
SOI
├─ 原图的 EXIF / ICC（普通模式：原字节；重编码模式：从原图复制）
├─ APP1 XMP  —— GContainer：声明主图 + 增益图（Item:Semantic="GainMap", Item:Length=...）
├─ APP2 ICC（如原图有）
├─ APP2 MPF  —— CIPA DC-007 多图索引，指向增益图偏移/大小
├─ 主图（SDR base）：普通 JPG 或 8-bit JPEG
├─ EOI
└─ 增益图（副图）：8-bit JPEG（全分辨率或半分辨率）+ 自身 APP1 XMP（hdrgm 元数据）
```

元数据采用与 Adobe Camera Raw / Google Ultra HDR 同构的写法，以最大化跨平台兼容：

- `hdrgm:Version="1.0"`、`hdrgm:BaseRenditionIsHDR="False"`
- `hdrgm:GainMapMin` / `GainMapMax` / `Gamma` 用 `rdf:Seq` 三通道序列（单色增益图时三值相同）
- `hdrgm:OffsetSDR` / `OffsetHDR` = 1/64
- `hdrgm:HDRCapacityMin` / `HDRCapacityMax`：显示端按屏幕亮度余量自适应提亮的范围

## 解码公式（显示端）

设增益图存储值 `g ∈ [0,1]`，元数据给出 `minLog`、`maxLog`（log2 增益范围）、`gamma`、`offsetSdr`、`offsetHdr`，显示端根据屏幕余量计算权重 `w`：

```
g'       = g ^ (1 / gamma)
logBoost = minLog + (maxLog - minLog) * g'
factor   = 2 ^ (logBoost * w)
HDR      = (SDR + offsetSdr) * factor - offsetHdr
```

因此：

- 普通屏 / 不支持 HDR 的显示环境：`w = 0` → 显示 SDR 主图，与普通 JPG 一致
- HDR 屏：按屏幕能力部分或全部应用增益
- 增益图里 g=0 的区域在 HDR 屏上也保持 SDR 亮度；只有 g>0 的区域被提亮

## 增益图如何生成

对原图每个像素计算一个"提亮指标"，再归一化成增益：

```
luma    = 0.2126R + 0.7152G + 0.0722B               （感知亮度，0-255）
metric  = max(luma, colorWeight * max(R,G,B))        （彩色高光也参与）
detail  = luma - blur(luma, detailRadius)            （局部小结构）
clarity = luma - blur(luma, detailRadius*4)          （大范围明暗对比）
metric += detailWeight * max(detail, 0)
metric += clarityWeight * max(clarity, 0)

g_base  = ((clamp(metric, knee, 255) - knee) / (255 - knee)) ^ curvePow
g       = g_base * (1 - portraitWeight * skinMask)   （人像保护）
```

- `knee`（提亮起点）、`curvePow`（过渡曲线）决定"哪些亮度参与提亮、过渡多陡"
- 细节尺度 = 上述 blur 半径（原图像素，按增益图分辨率缩放）
- 人像保护：YCbCr 肤色范围软检测，降低肤色区域的 g
- 结果写为 8-bit JPEG（q=0.90），分块处理避免大图爆内存

## 三种底图模式

| 模式 | 主图（SDR base） | 增益图 | 适用 |
|---|---|---|---|
| JPG 普通模式（默认） | **原图字节逐字节透传**，EXIF/ICC 不变 | 高光增益（g≥0） | 希望 SDR 回退与原始导出完全一致 |
| 整体曝光模式（EV>0） | 重编码：线性光 ×2^EV + 高光软肩压缩 | `M·g + log2(z/zd)` 归一化，K = M + log2(F/zdMax) + 0.05 | 背景也应该亮起来的照片（太阳、灯光、大光比） |
| PNG 输入 | 重编码为 JPEG（透明铺白、16-bit 降 8-bit） | 普通高光增益 | PNG 素材 |

曝光模式的色调映射（亮度保持，色相/饱和度不变）：

```
F     = 2^EV
z     = Y_linear * F
zd    = z <= T ? z : T + (1-T) * (1 - exp(-(z-T)/(1-T) * K_RATE))   # T=0.15, K_RATE=0.25
out   = z <= T ? z : zd
compress < 1 时与硬裁剪 out=min(z,1) 线性混合
SDR_base = clamp(orig_linear * F * (zd/z))
```

增益图里额外记录 `log2(z/zd)`，这样 HDR 屏上可以把被软肩压缩掉的高光再恢复出来。

## SDR/HDR 对比拼图

- 输出是一张 Ultra HDR JPG：上下两半**底图相同**（都是 SDR 底图），只有 HDR 那一半带真实增益图；另一半增益为 0。
- 因此：SDR 屏上两半看起来一致（区别靠标签提示）；HDR 屏上 HDR 一半会真实提亮，形成对比。
- 标签、中缝、水印区域的增益图同样清零，保持 SDR 观感。
- 输出尺寸可设为社交尺寸（长边 ≤4096，默认）或原分辨率（长边 ≤8192，避免超大图内存问题）。

## 水印与导出质量

- **水印后加**：先生成 SDR 底图与增益图，再把水印画到 SDR 底图；同时按水印形状生成蒙版，把增益图对应区域清零（带羽化）。
  这样 HDR 屏上水印保持 SDR 白，不会跟着高光一起被提亮。
- 水印存在时底图必须重编码（EXIF/ICC 尽量复制）；普通 JPG 直通模式不重编码。
- **JPEG 质量**只作用于重编码的底图；增益图质量固定 q≈0.90。直通模式质量由原图决定，界面会禁用滑块并提示。

## 为什么普通网页预览看不到 HDR

页面里的"增益示意 / 亮度余量 / 热力图"都画在普通 2D Canvas 上。浏览器把 Canvas 当 **SDR 内容**渲染，最高只能到 SDR 白（约 100–200 尼特），物理上无法输出"比白更亮"的 HDR 亮度。

要看到真实效果，两种方式：

1. **大图 HDR 调试**：把"最终导出的字节"直接放进 `<img>`，由浏览器原生 HDR 管线渲染（需要 HDR 屏 + 支持 HDR 图片的浏览器）
2. **直接查看导出文件**：用 Safari / 照片 App / 支持 HDR 的相册打开

页面用 `matchMedia('(dynamic-range: high)')` 显示本机 HDR 渲染状态（high / standard）。

## 校验方法

`tools/validate_output.py` 对输出做四层校验：

1. **容器结构**：MPF 条目数、偏移、主图/副图边界、副图完整 JPEG
2. **元数据**：主图 GContainer 长度、副图 hdrgm 字段、通道序列、capacity
3. **原图保留**：普通模式逐字节对比原图；重编码模式校验 EXIF 保留与底图接近程度
4. **像素/曲线**：按参数重算期望增益曲线并与解码增益图比对；重建 HDR 检查暗部/高光行为；检查强度 0 时恒等
