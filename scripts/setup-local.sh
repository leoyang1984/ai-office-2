#!/bin/sh
set -eu
umask 077
unset DEEPSEEK_API_KEY

root=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
cd "$root"
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  printf '%s\n' '当前本地部署支持 Apple 芯片 Mac。请用原生 ARM64 终端运行。' >&2
  exit 2
fi
if [ "$(node --version)" != "v$(cat .node-version)" ] || [ "$(pnpm --version)" != 12.16.1 ]; then
  printf '%s\n' '请安装项目指定的 Node.js 与 pnpm 12.16.1。' >&2
  exit 2
fi
case "$(docker context inspect desktop-linux --format '{{.Endpoints.docker.Host}}')" in
  unix:///*) ;;
  *) printf '%s\n' '请启动本机 Docker Desktop。' >&2; exit 2 ;;
esac
docker --context desktop-linux info --format '{{.OSType}}/{{.Architecture}}' | grep -Eq '^linux/(aarch64|arm64)$'

pnpm install --frozen-lockfile
pnpm build

prepared=$(mktemp -d /private/tmp/ai-office-local-build.XXXXXXXX)
trap 'rm -rf -- "$prepared"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
mkdir -p "$prepared/deps" .runtime
touch "$prepared/empty.npmrc"
cp workers/dsh-worker/dependencies/package.json \
   workers/dsh-worker/dependencies/pnpm-lock.yaml \
   workers/dsh-worker/dependencies/pnpm-workspace.yaml "$prepared/deps/"
(
  cd "$prepared/deps"
  # Docker copies these packages as root, while DSH runs as the host user ID.
  umask 022
  NPM_CONFIG_USERCONFIG="$prepared/empty.npmrc" NPM_CONFIG_GLOBALCONFIG="$prepared/empty.npmrc" \
    pnpm install --frozen-lockfile --ignore-scripts --prod --os linux --cpu arm64 --libc glibc \
    --registry https://registry.npmjs.org/ --store-dir "${AI_OFFICE_DSH_STORE:-$root/.runtime/dsh-store}"
)
docker --context desktop-linux buildx build --load --platform linux/arm64 --network none \
  --build-context "dsh_dependencies=$prepared/deps" --iidfile "$prepared/image" \
  --file infra/container/Dockerfile.web-local --tag "${AI_OFFICE_IMAGE_TAG:-ai-office-2-dsh-web:local-0.2.2-rc.1}" .
image=$(docker --context desktop-linux image inspect --format '{{.Id}}' "$(cat "$prepared/image")")
printf '%s\n' "$image" | grep -Eq '^sha256:[a-f0-9]{64}$'
receipt=$(mktemp .runtime/native-web-image.XXXXXXXX)
printf '%s\n' "$image" > "$receipt"
mv -f -- "$receipt" .runtime/native-web-image
printf '%s\n' '本地安装完成。运行 pnpm start:local 启动。'
