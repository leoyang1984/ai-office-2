#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
test "$(docker --context desktop-linux image inspect --format '{{.Id}}' ai-office-2-dsh:p3-0.2.2-rc.1)" = sha256:015fabdf2a516a0593ba12fcbda06535dbd261539b8d0f72bfc3af4d069212e7
case "$(docker context inspect desktop-linux --format '{{.Endpoints.docker.Host}}')" in
 unix:///*) ;;
 *) exit 2 ;;
esac
docker --context desktop-linux build --platform=linux/arm64 --network=none \
 --file "$root/infra/container/Dockerfile.web-r1" --tag ai-office-2-dsh-web:r1-0.2.2-rc.1 "$root"
