#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
test "$(docker --context desktop-linux image inspect --format '{{.Id}}' ai-office-2-dsh-web:r1-0.2.2-rc.1)" = sha256:250a2862a1b5d04cba8fc3480281d7904596fc8aa68485e47866bf76ee6ebdd3
case "$(docker context inspect desktop-linux --format '{{.Endpoints.docker.Host}}')" in
 unix:///*) ;;
 *) exit 2 ;;
esac
docker --context desktop-linux build --platform=linux/arm64 --network=none \
 --file "$root/infra/container/Dockerfile.web-r2" --tag ai-office-2-dsh-web:r2-0.2.2-rc.1 "$root"
