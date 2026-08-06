# OCR-APP — 浏览器端 OCR 研究验证项目

研究高可用、低消耗、识别能力强的小模型，验证 **onnx 客户端（浏览器）运行** 方案。

## 现状：PP-OCRv6 tiny 已验证跑通 ✅

基于微信公众号文章的方案，已在本地完成端到端验证：

| 验证项 | 结果 |
| --- | --- |
| 模型下载（ONNX 格式） | ✅ 官方仓库获取，det 1.78MB + rec 4.46MB |
| 字符集提取 | ✅ 官方 `inference.yml` 内嵌，6904 字符 |
| Python 端到端推理 | ✅ 中文/英文识别准确，见 `scripts/verify_pipeline.py` |
| 输出结构验证 | ✅ det: `[1,1,H,W]` 单通道概率图；rec: `[1,T,6906]` |

> ⚠️ 与微信文章的一个差异：文章表格写 det 输出 `[1,3,960,960]` 三通道，
> **实测官方模型输出是 `[1,1,H,W]` 单通道概率图**（文章代码实际也是按单通道处理的，仅表格描述有误）。

## 目录结构

```
OCR-APP/
├── docs/
│   └── wechat-paddleocr-onnx-browser.md   # 原始文章整理（含完整代码）
├── models/                                # ONNX 模型（git 忽略）
│   ├── PP-OCRv6_det_tiny.onnx             # 文本检测 1.78MB
│   └── PP-OCRv6_rec_tiny.onnx             # 文本识别 4.46MB
├── web/
│   ├── index.html                         # 浏览器 OCR 应用（单文件）
│   ├── ppocr_keys_v6_tiny.json            # 字符集 6904 字符
│   └── test_input.png                     # 验证用测试图
├── scripts/
│   ├── download_models.sh                 # 模型下载脚本（hf-mirror 加速）
│   ├── extract_charset.py                 # 从 inference.yml 提取字符集
│   ├── inference_rec.yml                  # 官方 rec 模型配置（含字符集）
│   └── verify_pipeline.py                 # Python 端到端验证脚本
```

## 快速开始

### 1. 运行网站 demo

```bash
cd web
# 任选一种静态服务器（必须 http 服务，file:// 会有 CORS 问题）
python3 -m http.server 3001
# 或 bun:  bunx --bun serve .  (需安装 serve: bun add -g serve)
```

浏览器打开 http://localhost:3001 ，等待模型加载后拖拽/点击上传图片识别。

### 2. 重新下载模型（如 models/ 被清理）

```bash
bash scripts/download_models.sh
```

### 3. Python 端到端验证（无需浏览器）

```bash
python3 scripts/verify_pipeline.py                 # 自动生成测试图并识别
python3 scripts/verify_pipeline.py 你的图片.png    # 识别指定图片
```

## 模型信息（官方仓库）

| 模型 | 仓库 | 文件 | 大小 | 输入 | 输出 |
| --- | --- | --- | --- | --- | --- |
| 检测 det | `PaddlePaddle/PP-OCRv6_tiny_det_onnx` | inference.onnx | 1.78MB | `[N,3,H,W]` 长边≤960、32 倍数 | `[N,1,H,W]` 单通道概率图 |
| 识别 rec | `PaddlePaddle/PP-OCRv6_tiny_rec_onnx` | inference.onnx | 4.46MB | `[N,3,48,W]` W≤3200 | `[N,T,6906]` logits |

- 字符集：6906 维 = **blank(0) + 6904 字符 + space(6905)**，官方 `inference.yml` 内嵌
- 识别时间步 T = W/8（48 高输入经 3 次下采样 → 8 倍压缩）
- 许可：Apache-2.0
- 源站：https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det_onnx
         https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_rec_onnx
  国内镜像：https://hf-mirror.com/PaddlePaddle/PP-OCRv6_tiny_det_onnx

## 推理参数（官方配置）

| 环节 | 参数 | 值 |
| --- | --- | --- |
| 检测预处理 | 长边上限 | 960（32 倍数取整） |
| 检测预处理 | mean/std | [0.485,0.456,0.406] / [0.229,0.224,0.225] |
| DBNet 后处理 | 二值化阈值 | 0.2 |
| DBNet 后处理 | 文本框平均概率阈值 | 0.4 |
| DBNet 后处理 | unclip 外扩系数 | 1.4（面积×系数/周长） |
| DBNet 后处理 | 最小短边 | 3px |
| 识别预处理 | 高度 | 48px（宽度按比例，上限 3200） |
| 识别预处理 | mean/std | [0.5,0.5,0.5] / [0.5,0.5,0.5] |
| CTC 解码 | 规则 | argmax → 去 blank(0) → 合并连续重复 |

## 关键经验（来自文章 + 实测）

1. **字符集必须与模型匹配**：外部下载的 6622 字典会全乱码。官方 `inference.yml` 直接提供，无需解析 protobuf
2. **softmax 防 NaN**：模型输出含 NaN 时 `Math.exp(NaN)` 会整行扩散，需 `isFinite` 防护
3. **置信度阈值不能设高**：6906 维 softmax 后单字符概率仅 ~0.05 量级（实测约 0.001-0.01），0.3 阈值会过滤全部结果
4. **det 输出单通道**：`[N,1,H,W]`，概率图分辨率与输入一致（模型内有恢复分辨率的上采样）
5. **识别按框裁剪**：每个检测框裁剪后缩放至 48px 高；超长文本需分块（每块宽 ≤3200 → T≤400）

## 网站开发建议（待办）

- [ ] 支持拖拽多图 / 批量识别
- [ ] 结果导出（纯文本 / JSON 带坐标）
- [ ] WebGPU 优先、WebGL 降级已在 demo 中实现，可测各浏览器性能
- [ ] 整页截图识别（长图需切片）
- [ ] 旋转/竖排文字检测优化（PP-OCRv6 支持，需处理检测框角度）
- [ ] 模型缓存（Service Worker）实现完全离线
- [ ] 对比 small/medium 模型（注意：small 检测头是二值图+轮廓检测，后处理不同）

## 参考

- 多模型验证站产品方案与实施计划：`docs/web-playground-plan.md`
- 微信公众号文章《网页端OCR, 加载6mb大小模型》：`docs/wechat-paddleocr-onnx-browser.md`
- PaddleOCR 官方：https://github.com/PaddlePaddle/PaddleOCR
- onnxruntime-web：https://github.com/microsoft/onnxruntime
