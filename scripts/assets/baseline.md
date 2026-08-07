# Tiny 固定基线（Python 对照）

本目录样例供 `scripts/verify_pipeline.py --baseline` 使用（仅 `--model ppocrv6-tiny`）。不追求全字符精确相等，只断言框数、关键片段与最少分块数，避免 OCR 完全失效仍退出 0。

| id | 文件 | 目的 | 断言要点 |
|---|---|---|---|
| `cn_en` | `test_input.png` | 复用已有中英文 | ≥2 框；含 `Hello` / `浏览器` / `12345` |
| `bgr_color` | `baseline_bgr_color.png` | 覆盖有色输入 / BGR 路径（当前不是 RGB/BGR 硬区分探针） | ≥2 框；含 `RED` / `BLUE` / `通道` |
| `long_parts` | `baseline_long_parts.png` | 必分块长文本 | ≥1 框；`parts≥2`；含 `ABCDEF` |
| `blank` | `baseline_blank.png` | 无文本 | 恰 0 框 |

运行：

```bash
python3 scripts/verify_pipeline.py --model ppocrv6-tiny --baseline
```
