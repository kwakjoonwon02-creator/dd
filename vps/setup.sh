#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

for command_name in docker git openssl; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "필수 명령이 없습니다: $command_name" >&2
    exit 1
  fi
done

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose V2(docker compose)가 필요합니다." >&2
  exit 1
fi

if [ ! -d invidious-src/.git ]; then
  git clone --depth 1 https://github.com/iv-org/invidious.git invidious-src
else
  git -C invidious-src pull --ff-only
fi

if [ ! -f .env ]; then
  DOMAIN=${1:-}
  if [ -z "$DOMAIN" ]; then
    echo "사용법: ./setup.sh video.example.com" >&2
    exit 1
  fi
  case "$DOMAIN" in
    *[!A-Za-z0-9.-]*|.*|*..*|*.)
      echo "올바른 DNS 도메인을 입력하세요." >&2
      exit 1
      ;;
  esac

  umask 077
  POSTGRES_PASSWORD=$(openssl rand -hex 24)
  HMAC_KEY=$(openssl rand -hex 32)
  COMPANION_KEY=$(openssl rand -hex 8)
  RELAY_KEY=$(openssl rand -hex 32)
  {
    printf 'DOMAIN=%s\n' "$DOMAIN"
    printf 'POSTGRES_PASSWORD=%s\n' "$POSTGRES_PASSWORD"
    printf 'HMAC_KEY=%s\n' "$HMAC_KEY"
    printf 'COMPANION_KEY=%s\n' "$COMPANION_KEY"
    printf 'RELAY_KEY=%s\n' "$RELAY_KEY"
    printf 'MAX_MEDIA_BYTES=1073741824\n'
  } > .env
  echo ".env와 임의 키를 생성했습니다."
else
  echo "기존 .env를 유지합니다."
fi

docker compose config >/dev/null
docker compose pull
docker compose up -d --build

echo
echo "컨테이너 상태:"
docker compose ps
echo
echo "Apps Script의 VPS_RELAY_URL: https://$(sed -n 's/^DOMAIN=//p' .env)"
echo "Apps Script의 RELAY_KEY: $(sed -n 's/^RELAY_KEY=//p' .env)"
echo "이 키가 출력되는 터미널 기록을 안전하게 관리하세요."
