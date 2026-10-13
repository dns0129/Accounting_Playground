#!/bin/bash
set -e
cd "$(dirname "$0")"
trap 'echo "启动失败，请查看上方提示。"; read -r -p "按回车关闭…"' ERR
node_bin=""
for candidate in "$(command -v node || true)" "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" /opt/homebrew/opt/node@24/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -x "$candidate" ] && "$candidate" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>24||(a===24&&b>=5)?0:1)' 2>/dev/null; then
    node_bin="$candidate"
    break
  fi
done
if [ -z "$node_bin" ]; then
  echo "需要 Node.js 24.5 或更新版本：https://nodejs.org/"
  exit 1
fi
export PATH="$(dirname "$node_bin"):$PATH"
if [ ! -d node_modules/@earendil-works/pi-coding-agent ]; then
  echo "首次启动：安装 pi agent…"
  npm ci --omit=dev
fi
export HOST=127.0.0.1
export PORT=8792
export ACCT_USE_LOCAL_SUBSCRIPTION=1
export APP_ORIGIN=https://dns0129.github.io
"$node_bin" --use-env-proxy scripts/launch.mjs
