#!/bin/zsh
set -eu
umask 077

office_root=${0:A:h:h}
office_node="$office_root/.runtime/node-v24.21.0-darwin-arm64/bin/node"
if [[ ! -x "$office_node" ]]; then
  print -u2 '项目 Node 24.21.0 运行时尚未准备好。'
  exit 2
fi
[[ "$("$office_node" --version)" == v24.21.0 ]]
export PATH="${office_node:h}:$PATH"
cd "$office_root"

case "${1:-remote}" in
  remote)
    office_origin=$("$office_node" -e '
      const {execFileSync} = require("node:child_process");
      const s = JSON.parse(execFileSync("tailscale",["status","--json"],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}));
      const host = s.Self?.DNSName?.replace(/\.$/,"");
      if (s.BackendState !== "Running" || !s.Self?.Online || !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/i.test(host??"")) {
        console.error("请先连接这台 Mac 的 Tailscale");process.exit(2);
      }
      console.log("https://" + host);
    ')
    export AI_OFFICE_ORIGIN="$office_origin"
    ;;
  local) export AI_OFFICE_ORIGIN=http://127.0.0.1:3000 ;;
  *)
    print -u2 '用法：zsh scripts/start-office.zsh [remote|local]'
    exit 2
    ;;
esac

export AI_OFFICE_DATA_ROOT="${AI_OFFICE_DATA_ROOT:-$office_root/data}"
if [[ ! -f "$AI_OFFICE_DATA_ROOT/db/office.sqlite" ]]; then
  "$office_node" apps/api/src/bootstrap.ts
  print '请保留上方临时密码，首次网页登录需要用它修改密码。'
fi
if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
  read -rs 'DEEPSEEK_API_KEY?请输入已有的 DeepSeek API Key，再按回车：'
  print
fi
if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
  print -u2 '需要 DeepSeek API Key 才能启动 DSH。'
  exit 2
fi
export DEEPSEEK_API_KEY
export AI_OFFICE_AGENT_MODE=dsh NODE_USE_ENV_PROXY=1
print "启动后请在浏览器打开 $AI_OFFICE_ORIGIN"
exec "$office_node" apps/api/src/main.ts
