# 素材入口

## 首帧目录／manifest

`queue --source <dir> --batch <dir>` 扫描图片与同名提示词。支持 PNG、JPG、JPEG、WebP，以及 `.txt`、`.md`、`.prompt`、含 `prompt` 的 `.json` 或 `.prompt.txt` 提示词。

素材目录有 `rhtv-manifest.json` 时清单优先。格式见仓库 `examples/`，它只包含虚构示例，不含真实素材。可以通过 `prompt_file` 读取相对于素材目录的提示词文件。

队列生成器目前处理首帧模式，单条清单支持 `ratio`、`duration`／`duration_seconds`、`resolution`。四种模式的统一投递使用下面两种入口。

## HTTP 投递

启动本机服务后，本机程序向 `POST http://127.0.0.1:47615/enqueue` 发送 JSON。该入口拒绝带浏览器 `Origin` 的投递；供终端和本机服务调用。

```bash
curl -X POST http://127.0.0.1:47615/enqueue \
  -H 'Content-Type: application/json' \
  -d '{"shot_id":"demo_s001","mode":"text","prompt":"虚构示例：纸风车在微风中转动。","duration":10}'
```

**投递会进入真实队列**，正在运行的页面提交器会读取并生成；上面不是离线测试命令。

| 模式 | `mode` | 图片字段 |
|---|---|---|
| 首帧 | `first` 或省略 | `image_path` 或 `image_base64` |
| 首尾帧 | `first_last` | 首帧 `image_*` 和尾帧 `last_image_path`／`last_image_base64` |
| 全能参考 | `reference` | `images` 数组，每项为路径或 `{ "path": "..." }`／`{ "base64": "..." }` |
| 文生视频 | `text` | 不带图片字段 |

`shot_id` 和 `prompt` 必填。`shot_id` 使用稳定且唯一的字母、数字、下划线、点或连字符；同 ID 同内容重复投递返回现有状态，不同内容拒收。

可选参数：`ratio`（默认 `16:9`）、`duration`（1–15 整数秒，默认 15）、`resolution`（默认 `768p`）、`priority`（`normal`／`high`）、`source`（本机来源标记）。比例支持 `16:9`、`9:16`、`1:1`、`4:3`、`3:4`。

HTTP 图片路径使用本机绝对路径；图片会复制到批次的 `intake/frames/`。支持 PNG/JPEG/WebP，单图最多 25 MB；全能参考还受请求体大小和模型实际张数上限约束，默认本机上限 9 张。字段缺失、图片多余或超限时拒收，不降级、不截断。

查看单条状态：`GET /status/<shot_id>`；`GET /health` 查看批次整体。

## inbox 投递

在 `<batch>/inbox/` 放 JSON 文件，字段与 HTTP 投递相同。相对图片路径以该 JSON 所在目录为基准，例如：

```json
{
  "shot_id": "demo_s002",
  "mode": "first_last",
  "image": "start.png",
  "last_image": "end.png",
  "prompt": "虚构示例：从静止纸风车过渡到转动的纸风车。"
}
```

先写好图片和 JSON 临时文件，再将 JSON 原子重命名为 `.json`，避免扫描到未写完的文件。默认每 30 秒扫描；已处理文件移入 `inbox/done/`，失败文件移入 `inbox/failed/` 并附 `.error.txt`。

所有素材、投递内容、状态、日志和视频都属于使用者的本机数据，不得添加到公开仓库。
