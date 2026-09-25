#!/bin/zsh

set -euo pipefail

PROJECT_DIR="${0:A:h}"
SERVER_DIR="$PROJECT_DIR/xingzhi/apps/server"
MINIAPP_DIR="$PROJECT_DIR/xingzhi/apps/miniapp"
ADMIN_WEB_DIR="$PROJECT_DIR/xingzhi/apps/web"
ENV_FILE="$PROJECT_DIR/xingzhi/.env"
CONCURRENTLY="$PROJECT_DIR/node_modules/.bin/concurrently"

SEED=0
BACKEND_ONLY=0
NO_BROWSER=0
RESTART=0

print_usage() {
  cat <<'EOF'
行止 macOS 一键启动脚本

用法：
  ./start-xingzhi.zsh [选项]

选项：
  --seed, -Seed                 仅在全新的隔离数据库中初始化演示数据
  --backend-only, -BackendOnly   只迁移并启动后端 Server
  --no-browser, -NoBrowser       不自动打开消费者 H5 页面
  --restart, -Restart            停止当前仓库的旧开发进程后再启动
  --help, -h                     显示帮助
EOF
}

die() {
  print ""
  print "[ERROR] $1" >&2
  exit 1
}

step() {
  print ""
  print "==> $1"
}

run_pnpm() {
  local failure_message="$1"
  shift
  if ! pnpm "$@"; then
    die "$failure_message"
  fi
}

port_in_use() {
  nc -z -w 1 127.0.0.1 "$1" >/dev/null 2>&1
}

http_ready() {
  curl --fail --silent --show-error --max-time 2 "$1" >/dev/null 2>&1
}

read_env_value() {
  local key="$1"
  sed -nE "s/^${key}=([^#]*)$/\1/p" "$ENV_FILE" | head -n 1 | sed 's/[[:space:]]+$//'
}

database_component() {
  local component="$1"
  local database_url="$2"
  node -e '
    const component = process.argv[1];
    const value = process.argv[2];
    const url = new URL(value);
    process.stdout.write(component === "host" ? url.hostname : (url.port || "5432"));
  ' "$component" "$database_url" 2>/dev/null
}

stop_xingzhi_processes() {
  local pid command_line
  local -a pids=()

  while IFS= read -r pid; do
    [[ -z "$pid" || "$pid" == "$$" ]] && continue
    command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    if [[ "$command_line" == *"$PROJECT_DIR"* ]]; then
      if [[ "$command_line" == *concurrently* ||
            "$command_line" == *"tsx watch"* ||
            "$command_line" == *"taro build"* ||
            "$command_line" == *"pnpm"*dev* ||
            "$command_line" == *"pnpm"*worker* ]]; then
        pids+=("$pid")
      fi
    fi
  done < <(pgrep -f "$PROJECT_DIR" || true)

  if (( ${#pids[@]} > 0 )); then
    kill "${pids[@]}" 2>/dev/null || true
    sleep 1
    print "已停止 ${#pids[@]} 个旧的行止开发进程。"
  fi
}

open_browser_when_ready() {
  if (( NO_BROWSER )); then
    return
  fi

  (
    local attempt
    for ((attempt = 1; attempt <= 60; attempt++)); do
      if http_ready "http://localhost:5173" && http_ready "http://127.0.0.1:8877/api/health"; then
        open "http://localhost:5173" >/dev/null 2>&1 || true
        exit 0
      fi
      sleep 1
    done
  ) >/dev/null 2>&1 &
}

while (( $# > 0 )); do
  case "$1" in
    --seed|-Seed)
      SEED=1
      ;;
    --backend-only|-BackendOnly)
      BACKEND_ONLY=1
      ;;
    --no-browser|-NoBrowser)
      NO_BROWSER=1
      ;;
    --restart|-Restart)
      RESTART=1
      ;;
    --help|-h)
      print_usage
      exit 0
      ;;
    *)
      die "未知选项：$1。使用 --help 查看用法。"
      ;;
  esac
  shift
done

cd "$PROJECT_DIR"

print "========================================"
print "        行止 Xingzhi macOS 一键启动"
print "========================================"
print "项目目录: $PROJECT_DIR"

command -v node >/dev/null 2>&1 || die "未检测到 Node.js。"
command -v pnpm >/dev/null 2>&1 || die "未检测到 pnpm。"
command -v nc >/dev/null 2>&1 || die "未检测到 nc，无法检查 PostgreSQL 端口。"
command -v curl >/dev/null 2>&1 || die "未检测到 curl，无法检查服务健康状态。"
command -v open >/dev/null 2>&1 || die "未检测到 macOS 的 open 命令。"

[[ -f "$ENV_FILE" ]] || die "找不到 xingzhi/.env，请先从 xingzhi/.env.example 复制并填写本地配置。"
[[ "$(read_env_value PORT)" == "8877" ]] || die "请在 xingzhi/.env 中设置 PORT=8877。"
[[ "$(read_env_value WEB_ORIGIN)" == "http://localhost:5173" ]] || die "请在 xingzhi/.env 中设置 WEB_ORIGIN=http://localhost:5173。"

DATABASE_URL="$(read_env_value DATABASE_URL)"
[[ -n "$DATABASE_URL" ]] || die "xingzhi/.env 中缺少 DATABASE_URL。"

if ! DATABASE_HOST="$(database_component host "$DATABASE_URL")"; then
  die "xingzhi/.env 中的 DATABASE_URL 格式不正确。"
fi
if ! DATABASE_PORT="$(database_component port "$DATABASE_URL")"; then
  die "xingzhi/.env 中的 DATABASE_URL 格式不正确。"
fi
[[ -n "$DATABASE_HOST" && -n "$DATABASE_PORT" ]] || die "xingzhi/.env 中的 DATABASE_URL 格式不正确。"

if ! nc -z -w 1 "$DATABASE_HOST" "$DATABASE_PORT" >/dev/null 2>&1; then
  die "无法连接 PostgreSQL ($DATABASE_HOST:$DATABASE_PORT)。请先启动 PostgreSQL。"
fi

if (( RESTART )); then
  step "清理旧的行止开发进程"
  stop_xingzhi_processes
fi

dependencies_ready=1
for executable in \
  "$CONCURRENTLY" \
  "$SERVER_DIR/node_modules/.bin/tsx" \
  "$MINIAPP_DIR/node_modules/.bin/taro" \
  "$ADMIN_WEB_DIR/node_modules/.bin/vite"; do
  if [[ ! -x "$executable" ]]; then
    dependencies_ready=0
  fi
done

if (( dependencies_ready )); then
  step "依赖已就绪"
else
  step "首次运行：安装项目依赖"
  run_pnpm "依赖安装失败，请查看上方第一条 pnpm 错误信息。" install
fi

FRONTEND_RUNNING=0
ADMIN_FRONTEND_RUNNING=0
BACKEND_RUNNING=0
port_in_use 5173 && FRONTEND_RUNNING=1
port_in_use 5174 && ADMIN_FRONTEND_RUNNING=1
port_in_use 8877 && BACKEND_RUNNING=1

if (( BACKEND_ONLY && BACKEND_RUNNING )); then
  if http_ready "http://127.0.0.1:8877/api/health"; then
    step "后端已经在 http://localhost:8877 运行且数据库连接正常，无需重复启动"
    exit 0
  fi
  die "8877 端口已有进程，但行止健康检查未通过。请使用 --restart 重启。"
fi

if (( ! BACKEND_ONLY )); then
  if (( FRONTEND_RUNNING && ADMIN_FRONTEND_RUNNING && BACKEND_RUNNING )); then
    http_ready "http://127.0.0.1:8877/api/health" || die "行止端口已占用，但后端或数据库未就绪。请使用 --restart 重启。"
    step "行止已经启动，后端与数据库健康检查通过"
    (( NO_BROWSER )) || open "http://localhost:5173"
    exit 0
  fi

  if (( FRONTEND_RUNNING || ADMIN_FRONTEND_RUNNING || BACKEND_RUNNING )); then
    if (( FRONTEND_RUNNING )); then
      occupied_port=5173
    elif (( ADMIN_FRONTEND_RUNNING )); then
      occupied_port=5174
    else
      occupied_port=8877
    fi
    die "端口 $occupied_port 已被其他进程占用。请使用 --restart 清理当前仓库的旧进程，或先手动关闭占用端口的进程。"
  fi
fi

step "执行数据库增量迁移"
run_pnpm "数据库迁移失败，请检查 PostgreSQL 和 xingzhi/.env 中的 DATABASE_URL。" db:migrate

if (( SEED )); then
  step "初始化本地测试数据"
  print "仅在全新的隔离测试数据库中使用 --seed；日常启动不要添加该参数。"
  run_pnpm "测试账号初始化失败。" db:seed
  if ! pnpm --filter @xingzhi/server db:seed:consumer-finance; then
    print "[WARN] A00 资金样例未写入。现有账户或预算受保护，不会被脚本覆盖；项目仍将继续启动。"
  fi
fi

if (( BACKEND_ONLY )); then
  step "启动后端 Server"
  print "后端地址: http://localhost:8877"
  print "按 Ctrl+C 停止服务。"
  exec pnpm --dir "$SERVER_DIR" dev
fi

step "启动行止（Server / Worker / 消费者端 / 管理端 / 微信小程序编译）"
WEAPP_API_BASE="${TARO_APP_API_BASE:-http://127.0.0.1:8877}"
print "消费者端: http://localhost:5173"
print "商户/审核端: http://localhost:5174"
print "后端地址: http://localhost:8877"
print "微信产物: xingzhi/apps/miniapp/dist/weapp"
print "微信 API: $WEAPP_API_BASE"
print "测试账号: consumer-a@xingzhi.local"
print "按 Ctrl+C 停止全部服务。"

export TARO_APP_API_BASE="$WEAPP_API_BASE"
open_browser_when_ready

exec "$CONCURRENTLY" \
  --names "server,worker,h5,admin,weapp" \
  --prefix-colors "green,yellow,cyan,blue,magenta" \
  --kill-others-on-fail \
  "pnpm --dir \"$SERVER_DIR\" dev" \
  "pnpm --dir \"$SERVER_DIR\" worker" \
  "pnpm --dir \"$MINIAPP_DIR\" dev:h5" \
  "pnpm --dir \"$ADMIN_WEB_DIR\" dev" \
  "NODE_ENV=production pnpm --dir \"$MINIAPP_DIR\" dev:weapp"
