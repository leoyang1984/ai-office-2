#!/bin/sh
set -eu

root=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
test "$(node --version)" = v24.21.0
test "$(pnpm --version)" = 12.16.1
case "$(docker context inspect desktop-linux --format '{{.Endpoints.docker.Host}}')" in
  unix:///*) ;;
  *) printf '%s\n' 'Local desktop-linux context required' >&2; exit 2 ;;
esac
prepared=$(mktemp -d /tmp/ai-office-2-worker-deps.XXXXXXXX)
trap 'rm -rf -- "$prepared"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$prepared/deps" "$prepared/install-home"
touch "$prepared/empty.npmrc"
cp "$root"/workers/dsh-worker/dependencies/package.json \
  "$root"/workers/dsh-worker/dependencies/pnpm-lock.yaml \
  "$root"/workers/dsh-worker/dependencies/pnpm-workspace.yaml "$prepared/deps/"
(
  cd "$prepared/deps"
  env HOME="$prepared/install-home" NPM_CONFIG_USERCONFIG="$prepared/empty.npmrc" \
    NPM_CONFIG_GLOBALCONFIG="$prepared/empty.npmrc" \
    pnpm install --frozen-lockfile --ignore-scripts --prod --os linux --cpu arm64 --libc glibc \
    --registry https://registry.npmjs.org/ --store-dir "${P2_PNPM_STORE:-$prepared/store}"
)
docker --context desktop-linux build --platform linux/arm64 --network=none \
  --build-context "dsh_dependencies=$prepared/deps" \
  --file "$root/infra/container/Dockerfile" --tag ai-office-2-dsh:p3-0.2.2-rc.1 "$root"
