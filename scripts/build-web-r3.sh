#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
test "$(docker --context desktop-linux image inspect --format '{{.Id}}' ai-office-2-dsh-web:r2-0.2.2-rc.1)" = sha256:c8d9ef204cdd92690fe1bd25862b9156674aff1f29261cac06014bd332c40927
case "$(docker context inspect desktop-linux --format '{{.Endpoints.docker.Host}}')" in
 unix:///*) ;;
 *) exit 2 ;;
esac
docker --context desktop-linux build --platform=linux/arm64 --network=none \
 --file "$root/infra/container/Dockerfile.web-r3" --tag ai-office-2-dsh-web:r3-0.2.2-rc.1 "$root"
