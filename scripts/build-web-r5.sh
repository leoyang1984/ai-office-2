#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
case "$(docker context inspect desktop-linux --format '{{.Endpoints.docker.Host}}')" in
 unix:///*) ;;
 *) exit 2 ;;
esac
test "$(docker --context desktop-linux image inspect --format '{{.Id}}' ai-office-2-dsh-web:r3-0.2.2-rc.1)" = sha256:56a0a59b5255d6841f64ff8fd6880f1f17dcce35cf5bc8607cb697bd360d5ad2
docker --context desktop-linux build --platform=linux/arm64 --network=none \
 --file "$root/infra/container/Dockerfile.web-r5" --tag ai-office-2-dsh-web:r5-0.2.2-rc.1 "$root"
