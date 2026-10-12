#!/bin/bash
# launchd agents for the native RunningHub submitter: the local server (always on) and its watchdog.
#
#   rhtv-native-launchd.sh render    server|watchdog  [options]   print the plist, change nothing
#   rhtv-native-launchd.sh install   server|watchdog  [options]   write ~/Library/LaunchAgents/<label>.plist and load it
#   rhtv-native-launchd.sh uninstall server|watchdog  [--port N]  unload it and remove the plist
#   rhtv-native-launchd.sh status    server|watchdog  [--port N]  launchctl state, + /health for the server
#   rhtv-native-launchd.sh logs      server|watchdog  [--port N]  follow the log files
#
# Options (or environment variables):
#   --batch DIR      RHTV_NATIVE_BATCH   batch root (holds formal-video-queue.json); required for render/install
#   --port N         RHTV_NATIVE_PORT    default 47615; part of the label, so two accounts can each have one
#   --python PATH    RHTV_PYTHON         absolute python3; default: `command -v python3`
#   --repo DIR       RHTV_REPO           repository root; default: the one holding this script
#   --no-keep-awake                      server only: do not hold off system sleep (caffeinate) while it runs
#   --log-dir DIR    RHTV_LOG_DIR        default ~/Library/Logs
#
# The server agent has RunAtLoad + KeepAlive: started at login, restarted 10 s after any exit.
# The watchdog agent runs every 300 s.
set -euo pipefail

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-2}"; }

cmd="${1:-}"; kind="${2:-}"
[[ "$cmd" =~ ^(render|install|uninstall|status|logs)$ && "$kind" =~ ^(server|watchdog)$ ]] || usage
shift 2

batch="${RHTV_NATIVE_BATCH:-}"; port="${RHTV_NATIVE_PORT:-47615}"; python="${RHTV_PYTHON:-}"
repo="${RHTV_REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"; keep_awake=1; log_dir="${RHTV_LOG_DIR:-$HOME/Library/Logs}"
while (($#)); do
  case "$1" in
    --batch) batch="$2"; shift 2 ;;
    --port) port="$2"; shift 2 ;;
    --python) python="$2"; shift 2 ;;
    --repo) repo="$2"; shift 2 ;;
    --log-dir) log_dir="$2"; shift 2 ;;
    --no-keep-awake) keep_awake=0; shift ;;
    -h|--help) usage 0 ;;
    *) echo "未知参数：$1" >&2; usage ;;
  esac
done
[[ "$port" =~ ^[0-9]+$ ]] || { echo "--port 必须是数字" >&2; exit 2; }

label="io.runninghub-h3-autosubmit.native-$kind.$port"
plist="$HOME/Library/LaunchAgents/$label.plist"
out_log="$log_dir/rhtv-native-$kind.$port.out.log"
err_log="$log_dir/rhtv-native-$kind.$port.err.log"
domain="gui/$(id -u)"

xml() { local s="$1"; s="${s//&/&amp;}"; s="${s//</&lt;}"; s="${s//>/&gt;}"; printf '%s' "$s"; }

render() {
  [[ -n "$batch" ]] || { echo "需要 --batch（批次目录的绝对路径）" >&2; exit 2; }
  [[ "$batch" = /* && "$repo" = /* ]] || { echo "--batch 和 --repo 必须是绝对路径" >&2; exit 2; }
  if [[ -z "$python" ]]; then python="$(command -v python3 || true)"; fi
  [[ -n "$python" && "$python" = /* ]] || { echo "找不到 python3；用 --python 指定绝对路径" >&2; exit 2; }
  local args=()
  if [[ "$kind" == server ]]; then
    args=("$python" "$repo/scripts/runninghub/rhtv-native-server.py" --batch "$batch" --port "$port")
    ((keep_awake)) && args+=(--keep-awake)
  else
    args=("$python" "$repo/scripts/runninghub/rhtv-native-watchdog.py" --batch "$batch" --port "$port")
  fi
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$(xml "$label")</string>
  <key>ProgramArguments</key>
  <array>
$(for a in "${args[@]}"; do printf '    <string>%s</string>\n' "$(xml "$a")"; done)
  </array>
  <key>WorkingDirectory</key><string>$(xml "$HOME")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>PYTHONUNBUFFERED</key><string>1</string>
  </dict>
EOF
  if [[ "$kind" == server ]]; then
    cat <<EOF
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
EOF
  else
    cat <<EOF
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>300</integer>
EOF
  fi
  cat <<EOF
  <key>StandardOutPath</key><string>$(xml "$out_log")</string>
  <key>StandardErrorPath</key><string>$(xml "$err_log")</string>
</dict>
</plist>
EOF
}

case "$cmd" in
  render) render ;;
  install)
    content="$(render)"
    mkdir -p "$HOME/Library/LaunchAgents" "$log_dir"
    if [[ "$kind" == server ]] && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 \
       && ! launchctl print "$domain/$label" >/dev/null 2>&1; then
      echo "端口 $port 已被一个手动启动的服务占用。先停掉它（Ctrl-C 或 kill），再安装；否则 launchd 版会反复启动失败。" >&2
      exit 1
    fi
    launchctl bootout "$domain/$label" 2>/dev/null || true
    printf '%s\n' "$content" > "$plist"
    plutil -lint "$plist" >/dev/null
    launchctl bootstrap "$domain" "$plist"
    echo "已安装并启动 $label"
    echo "  配置：$plist"
    echo "  日志：$out_log / $err_log"
    echo "  几秒后用 '$0 status $kind --port $port' 确认；日志里出现 'Operation not permitted' 就是桌面目录权限（见 rhtv-native.md）"
    ;;
  uninstall)
    launchctl bootout "$domain/$label" 2>/dev/null && echo "已停止 $label" || echo "$label 没有在运行"
    rm -f "$plist" && echo "已删除 $plist"
    ;;
  status)
    launchctl print "$domain/$label" 2>/dev/null | grep -E '^\s*(state|pid|last exit code|runs) ' || echo "$label 未加载"
    [[ "$kind" == server ]] && { curl -fsS "http://127.0.0.1:$port/health" && echo || echo "127.0.0.1:$port/health 无响应"; }
    echo "--- $err_log（最后 20 行）"; tail -n 20 "$err_log" 2>/dev/null || true
    ;;
  logs) touch "$out_log" "$err_log" 2>/dev/null || true; tail -n 50 -F "$out_log" "$err_log" ;;
esac
