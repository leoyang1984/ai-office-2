#!/bin/sh
set -eu

image='docker.io/library/alpine@sha256:24bb3511a0db7b5114a4aee033c65a8a4148f39b7b80a398e548546db967a36f'
context=${P0_DOCKER_CONTEXT:-desktop-linux}

blocked() {
  printf 'BLOCKED: %s\n' "$1" >&2
  exit 2
}

command -v docker >/dev/null 2>&1 || blocked 'Docker CLI unavailable'
endpoint=$(docker context inspect "$context" --format '{{.Endpoints.docker.Host}}') ||
  blocked 'Docker context unavailable'
case "$endpoint" in unix:///*) ;; *) blocked 'Local Unix socket required';; esac
engine=$(docker --context "$context" info --format '{{.ServerVersion}} {{.OSType}}/{{.Architecture}}') ||
  blocked 'Docker engine is not reachable'
printf 'Docker engine: %s\n' "$engine"
[ "$(id -u)" -ne 0 ] || blocked 'Run the probe as a non-root host user'

umask 077
root=$(mktemp -d /private/tmp/ai-office-2-p0-mounts.XXXXXXXX)
trap 'rm -rf -- "$root"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$root/A/workspace" "$root/A/dsh-home" "$root/B/workspace" "$root/B/dsh-home" +  "$root/knowledge/granted" "$root/knowledge/denied" "$root/host-home"
printf 'synthetic granted data\n' > "$root/knowledge/granted/note.txt"
printf 'synthetic other tenant\n' > "$root/B/workspace/private.txt"
printf 'synthetic other home\n' > "$root/B/dsh-home/private.txt"
printf 'synthetic denied data\n' > "$root/knowledge/denied/private.txt"
printf 'synthetic host data\n' > "$root/host-home/private.txt"
sha_before=$(shasum -a 256 "$root/knowledge/granted/note.txt" | cut -d ' ' -f1)

docker --context "$context" run --rm --pull=missing --platform linux/arm64 \
  --network none --user "$(id -u):$(id -g)" --read-only --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 32 --memory 64m --cpus 0.5 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=8m \
  --mount "type=bind,source=$root/A/workspace,target=/tenant/workspace" \
  --mount "type=bind,source=$root/A/dsh-home,target=/tenant/dsh-home" \
  --mount "type=bind,source=$root/knowledge/granted,target=/knowledge/granted,readonly" \
  --workdir /tenant/workspace --env HOME=/tenant/dsh-home "$image" sh -eu -c '
    deny() {
      if "$@" >/dev/null 2>&1; then
        printf "FAIL: unexpected permission for %s\n" "$1" >&2
        exit 1
      fi
    }
    [ "$(uname -m)" = aarch64 ]
    [ "$(id -u)" -ne 0 ]
    [ "$(pwd)" = /tenant/workspace ]
    grep -Eq "^NoNewPrivs:[[:space:]]+1$" /proc/self/status
    grep -Eq "^CapEff:[[:space:]]+0+$" /proc/self/status
    awk '\''$5=="/knowledge/granted" && $6 ~ /(^|,)ro(,|$)/ {found=1} END {exit !found}'\'' /proc/self/mountinfo
    printf "generated\n" > result.txt
    printf "session state\n" > "$HOME/state.txt"
    [ "$(cat /knowledge/granted/note.txt)" = "synthetic granted data" ]
    deny touch /knowledge/granted/new.txt
    deny sh -c "printf changed > /knowledge/granted/note.txt"
    deny rm /knowledge/granted/note.txt
    deny mv /knowledge/granted/note.txt /knowledge/granted/moved.txt
    deny chmod 0777 /knowledge/granted/note.txt
    deny ln -s /tenant/workspace /knowledge/granted/escape
    deny touch /usr/p0-write
    for path in /tenant/B/workspace/private.txt /tenant/B/dsh-home/private.txt \
      /knowledge/denied/private.txt /host-home/private.txt; do
      deny cat "$path"
    done
    [ ! -e /var/run/docker.sock ]
    [ ! -e /run/docker.sock ]
    [ -z "${SSH_AUTH_SOCK:-}" ]
    [ ! -e /Users ]
    [ ! -e /root/.dsh ]
  '

[ "$(cat "$root/A/workspace/result.txt")" = generated ]
[ "$(cat "$root/A/dsh-home/state.txt")" = 'session state' ]
sha_after=$(shasum -a 256 "$root/knowledge/granted/note.txt" | cut -d ' ' -f1)
[ "$sha_before" = "$sha_after" ]
printf 'PASS: Linux ARM64, workspace/home RW, knowledge RO and unchanged, sibling mounts and host sockets absent\n'
