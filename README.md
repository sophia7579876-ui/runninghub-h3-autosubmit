# RunningHub H3 自动提交

供 Codex、Claude Code 或终端使用的独立脚本项目。使用自己的 RunningHub 登录态，将图片和提示词提交到 Minimax H3 RH Enhanced 会员模型，查询进度并下载成片。

仓库只有脚本、合成测试和必要文档。没有账号、Cookie、API Key、真实素材、生产队列、生成记录或视频。不需要 npm/pip 依赖安装。

## 交给 Agent 部署

在 Codex 或 Claude Code 中打开本项目，输入：

> 请阅读 AGENTS.md 和 docs/deploy.md，检查本机环境并部署这个项目。使用我指定的素材目录和独立批次目录，保留已有运行进度。先验证本机服务和浏览器启动条件，报告状态；真实生成任务等我提供素材和要求后再启动。

Agent 使用普通终端命令部署；浏览器自动操作是可选能力。没有浏览器工具时，自己在已登录画布的控制台粘贴启动代码即可。无需安装本项目专属 MCP 或插件。

## 环境与工作方式

- Python 3.10+、Node.js 18+、已登录 RunningHub 的 Chrome/Chromium 浏览器。
- 账号自行具备对应会员模型的使用权益；实际可用时段、并发和报价以账号与平台返回为准。
- 运行结构：本机 Python 服务提供队列与图片；已登录画布内的 JavaScript 调用网页自身模块完成上传、询价、提交、轮询。
- 画布标签页必须保持打开，电脑必须保持运行。仅启动 Python 服务不会生成视频。
- macOS 提供 launchd 常驻脚本；其他系统使用前台服务入口，常驻部署需按对应系统配置。

## 快速开始

先克隆／下载仓库并进入项目目录。以下 shell 示例适用于 macOS/Linux；Windows 可用 `python` 替代 `python3`，路径使用本机实际路径。

### 1. 检查环境

```bash
python3 scripts/rhtv.py doctor --port 47615
```

退出码 0 表示已通过脚本、运行时和端口的本地检查。登录状态、模型权益和浏览器本地网络访问仍需在页面中验证。

### 2. 准备自己的素材

在仓库外的素材目录放 `s001.png` 和 `s001.txt`（提示词）；也可使用 `rhtv-manifest.json`，格式见 [examples/rhtv-manifest.example.json](examples/rhtv-manifest.example.json)。示例只有虚构文件名，不附图片。

```bash
python3 scripts/rhtv.py queue --source /absolute/path/to/materials --batch /absolute/path/to/batch
python3 scripts/rhtv.py doctor --batch /absolute/path/to/batch
```

生成 `formal-video-queue.json`，不会联网提交。目录／manifest 入口用于首帧模式。其他模式通过 HTTP 或 inbox 投递，见 [docs/inputs.md](docs/inputs.md)。

提示词只去首尾空白，不进行创作或改写。队列中图片记录 SHA-256；图片被改动后需确认内容并重新生成队列。重新生成队列不会清空 `native-state.json`。

### 3. 启动本机服务

临时使用，在独立终端保持前台运行：

```bash
python3 scripts/rhtv.py serve --batch /absolute/path/to/batch --port 47615
```

过夜使用 macOS launchd，参见 [部署说明](docs/deploy.md)。本机服务只监听 `127.0.0.1`；不需要公开端口。

### 4. 启动页面提交器

打开自己账号下的画布 `https://rhtv.runninghub.cn/project/canvas/<id>`，等页面加载完成。在项目终端输出启动代码：

```bash
python3 scripts/rhtv.py snippet --port 47615
```

在该画布的开发者工具控制台粘贴输出代码。浏览器可能提示允许 RunningHub 访问本地网络，需要在本机允许该站点访问服务。

启动后会按队列自动提交任务。不要将代码粘贴到无关网站；不要给别人发送含登录信息的浏览器截图、Cookie 或网络请求导出。

## 默认参数

| 参数 | 默认值 | 修改方式 |
|---|---|---|
| 并发上限 | 2 | `concurrency`；会根据平台拒绝情况降低实际并发 |
| 每次生成数量 | 1 | `generateNum`；2 表示两条随机版本，不是加速 |
| 提交时段 | UTC+8 的 21:00–10:00 | `windowHours`；按自己的账号权益调整 |
| 真实生成失败尝试上限 | 3 | `maxAttempts` |
| 端口 | 47615 | 各命令的 `--port` |

复制 [config.example.json](config.example.json) 为本机 `config.local.json`，调整后输出代码：

```bash
python3 scripts/rhtv.py snippet --port 47615 --config config.local.json
```

配置仅用于生成启动代码；修改后需要停止并重新启动页面提交器才生效。本机服务不读取这些生成参数。

仅选择 H3 Enhanced 的会员 `-app` 模型；四种模式均需询价成功且报价为 0 才提交，缺失报价或非零报价会拒绝该任务。不自动切换收费模型。

## 查看、停止与恢复

```bash
python3 scripts/rhtv.py status --port 47615
python3 scripts/rhtv.py stop --port 47615 --wait 180
```

`status` 显示本机服务、页面实例、源码版本、任务计数和缺失视频。`stop` 停止页面继续提交，不取消平台已经受理的任务。服务仍保持运行；恢复时再次执行页面启动代码。

同一批次有心跳有效的实例时，第二个提交器会被拒绝。单实例控制的范围是批次；同一个账号请只运行一个批次提交器。不同账号使用独立浏览器用户、批次目录和端口。

进度存于 `<batch>/native-state.json`，事件存于 `native-events.jsonl`，结果在 `videos/`。这些都是本机私有数据。不要删除状态文件来重试；正常恢复会沿用有任务 ID 的运行记录。

平台受理与本机记录之间不能保证原子性。如果在受理后、记录任务 ID 前崩溃，恢复可能重复提交，应先核对画布与任务。不要把本工具当作严格的“只提交一次”系统。

## 验证与限制

```bash
node --test scripts/tests/*.test.mjs
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/tests -p '*_test.py'
```

测试使用内存假平台和临时本机服务，不登录 RunningHub，也不生成真实视频。部署前的本地测试通过不代表账号权益、所有模式或当前网站版本已完成真实验证。

网页内接口不是稳定的公开 SDK。网站更新后可能出现 `API_ANCHOR_CHANGED`、`PAGE_MODULE_MISSING` 等错误，需要更新适配；不要通过放宽模型／报价校验强行运行。

更多说明：[部署与排障](docs/deploy.md) · [四种模式与投递格式](docs/inputs.md) · [公开仓库检查](docs/sharing.md)
