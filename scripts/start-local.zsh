#!/bin/zsh
set -eu
umask 077
cd -- "${0:A:h:h}"

if [[ "$(node --version)" != "v$(cat .node-version)" ]]; then
  print -u2 '请使用项目指定的 Node.js 版本。'
  exit 2
fi
if [[ ! -f .runtime/native-web-image || ! -f apps/web/dist/index.html ]]; then
  print -u2 '请先运行 pnpm setup:local。'
  exit 2
fi
export AI_OFFICE_DATA_ROOT="${AI_OFFICE_DATA_ROOT:-$HOME/Library/Application Support/AI Office 2.0}"
if [[ "$AI_OFFICE_DATA_ROOT" != /* ]]; then
  print -u2 'AI_OFFICE_DATA_ROOT 必须使用绝对路径。'
  exit 2
fi
if [[ ! -f "$AI_OFFICE_DATA_ROOT/db/office.sqlite" ]]; then
  env -u DEEPSEEK_API_KEY node apps/api/src/bootstrap.ts
fi
if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
  read -rs 'DEEPSEEK_API_KEY?DeepSeek API Key: '
  print
fi
if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
  print -u2 '请输入 DeepSeek API Key。'
  exit 2
fi
export DEEPSEEK_API_KEY
export NODE_USE_ENV_PROXY="${NODE_USE_ENV_PROXY:-1}"
exec node apps/api/src/native-main.ts
