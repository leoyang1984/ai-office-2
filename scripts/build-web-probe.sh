#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
base=$(docker --context desktop-linux image inspect --format '{{.Id}}' ai-office-2-dsh:p3-0.2.2-rc.1)
test "$base" = sha256:015fabdf2a516a0593ba12fcbda06535dbd261539b8d0f72bfc3af4d069212e7
case "$(docker context inspect desktop-linux --format '{{.Endpoints.docker.Host}}')" in
 unix:///*) ;;
 *) printf '%s\n' 'Local desktop-linux context required' >&2; exit 2 ;;
esac
docker --context desktop-linux build --platform=linux/arm64 --network=none \
 --file "$root/infra/container/Dockerfile.web-probe" --tag ai-office-2-dsh-web:r0-0.2.2-rc.1 "$root"
