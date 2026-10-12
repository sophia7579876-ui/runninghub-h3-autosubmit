# 本机部署与排障

## 部署检查

1. 将项目克隆／解压到自己的代码目录，建议使用 `~/projects/` 等桌面以外的位置。
2. 检查 `python3 --version`、`node --version`，分别需要 Python 3.10+ 和 Node 18+。不需要 pip/npm 安装。
3. `python3 scripts/rhtv.py doctor --port 47615` 检查脚本和端口。端口已有服务时先看服务属于哪个批次；不覆盖其他进程。
4. 用户提供自己的素材目录、独立批次目录、账号时段和生成参数。批次目录建议放仓库外，例如 `~/rhtv-data/my-batch`。
5. 使用 README 的 `queue` 命令导入首帧目录；也可以启动空批次，稍后向 HTTP/inbox 投递。不要为“验证部署”编造真实生成任务。

若 `python3` 指向 macOS 自带的旧版本，先寻找已安装的 Python 3.10+，后续命令使用其绝对路径；不要仅因 PATH 顺序问题重复安装运行时。launchd 安装时也可用 `--python <absolute-python-path>` 明确指定同一个解释器。

统一入口 `scripts/rhtv.py` 支持 `doctor`、`queue`、`serve`、`snippet`、`status`、`stop`，各命令均支持 `--help`。

## macOS 常驻服务

从仓库根目录执行，替换下面的批次目录；所有路径均为自己电脑上的路径：

```bash
mkdir -p "$HOME/rhtv-data/my-batch"
scripts/launchd/rhtv-native-launchd.sh render server --batch "$HOME/rhtv-data/my-batch"
scripts/launchd/rhtv-native-launchd.sh install server --batch "$HOME/rhtv-data/my-batch"
scripts/launchd/rhtv-native-launchd.sh status server
```

`render` 只输出配置；`install` 写入 `~/Library/LaunchAgents/` 并启动服务。`KeepAlive` 会在服务退出后重新拉起。默认启用 `caffeinate`，系统有此命令时在服务运行期间防止空闲睡眠。

脚本默认以自己所在仓库为代码位置；可以用 `--repo` 指定。端口可以用 `--port` 指定，第二个账号还需独立浏览器用户和批次目录。

可选看门狗：

```bash
scripts/launchd/rhtv-native-launchd.sh install watchdog --batch "$HOME/rhtv-data/my-batch"
scripts/launchd/rhtv-native-launchd.sh status watchdog
```

看门狗检查服务可达性、批次、登录失效和进度。消息仅在本机打印／显示桌面通知，不向聊天软件发送。其“进度过期”检查目前固定按 UTC+8 的 21:00–10:00 判断；使用其他免费时段时，暂不安装看门狗或同步修改该脚本的时段常量。

服务标签为 `io.runninghub-h3-autosubmit.native-server.<port>`，看门狗为对应的 `native-watchdog.<port>`。日志位于 `~/Library/Logs/`，属于本机私有记录。

卸载自己安装的服务：

```bash
python3 scripts/rhtv.py stop --wait 180
scripts/launchd/rhtv-native-launchd.sh uninstall watchdog
scripts/launchd/rhtv-native-launchd.sh uninstall server
```

卸载不会删除素材、状态或成片。退出 Agent 不代表卸载服务。

## 其他系统／临时前台运行

```bash
python3 scripts/rhtv.py serve --batch /absolute/path/to/batch --port 47615
```

服务运行在前台，终端必须保持打开。Windows 可在 PowerShell 中使用 `python scripts/rhtv.py serve --batch "C:\rhtv-data\my-batch"`。Windows/Linux 的系统常驻配置不在本项目提供的 launchd 脚本范围内，部署时需按本机环境另行配置。

macOS launchd 渲染及本机服务在 macOS 下验证；其他系统尚未完成实际部署验收，不应报告为已验证支持。

## 页面启动与验收

1. 自己登录 RunningHub 并打开 `/project/canvas/<id>`。不能使用作者的画布 ID、Cookie 或账号。
2. 用 `python3 scripts/rhtv.py snippet --port 47615` 输出代码；有本机配置时增加 `--config config.local.json`。
3. 用户要求开始生成后，将代码执行在上述已登录画布里。可以使用当前 Agent 已有浏览器工具，或者手动粘贴。
4. `python3 scripts/rhtv.py status` 应显示 `instance.alive: true`，批次正确，`instance.info` 中并发和生成数量符合预期。
5. `instance.info.code_version` 应与 `server.runner_on_disk` 一致。磁盘代码更新不会自动替换页面里运行的代码。
6. 真实任务完成后检查 `videos/` 是否有文件，以及 `missing_videos` 是否为 0。仅部署空队列时不要把这个检查说成真实生成验收。

未启动页面程序时，准确报告本机服务已就绪、尚未开始提交。

## 换参数／更新代码

先运行 `python3 scripts/rhtv.py stop --wait 180`。退出码 0 表示页面实例已注销；非零先查原因，不直接启动第二个。

停止后更新代码，重启本机服务，再刷新画布并执行新启动代码。macOS 服务可使用：

```bash
launchctl kickstart -k "gui/$(id -u)/io.runninghub-h3-autosubmit.native-server.47615"
```

保留批次下的所有进度；正常恢复查询已有任务并补下载。限流等待由页面程序负责，不通过重启清空等待。

## 常见问题

| 现象 | 处理 |
|---|---|
| 端口占用 | 检查已有服务所属批次；为独立账号选择另一端口，所有命令保持一致 |
| 页面 fetch 本机失败 | 确认服务运行、本地网络权限已允许、端口与代码一致 |
| `NOT_ON_CANVAS` | 在 `/project/canvas/<id>` 页面执行代码 |
| `INSTANCE_ACTIVE` | 已有实例；先查看状态，需要换设置时停止旧实例 |
| `API_ANCHOR_CHANGED` | 网站模块变化，更新适配；保留零费与模型检查 |
| `AUTH_INVALID` | 重新登录自己的账号，确认画布连接恢复 |
| `QUOTE_NOT_FREE` | 该任务询价失败或不是 0，检查权益与参数，不自动改收费模式 |
| `PermissionError` / `Operation not permitted` | macOS 后台进程无法访问桌面等目录；优先把代码和批次放在这些目录以外 |
| 队列图片找不到／哈希不符 | 核对自己的素材路径和文件；确认后重新生成队列，保留原进度 |
| 已完成但缺视频 | 服务会补下载；地址失效时可能无法补下，检查本机事件日志 |

过夜时保持接电和系统运行，笔记本不要合盖；将 RunningHub 加入 Chrome 性能设置的始终保持活动站点。launchd 只能重启本机服务，不能替你恢复关闭的画布标签页。
