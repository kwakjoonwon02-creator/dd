#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

for command_name in docker git openssl tailscale jq; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "필수 명령이 없습니다: $command_name" >&2
    exit 1
  fi
done

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose V2(docker compose)가 필요합니다." >&2
  exit 1
fi

TAILSCALE_STATUS=$(tailscale status --json 2>/dev/null || true)
if [ -z "$TAILSCALE_STATUS" ]; then
  echo "Tailscale이 실행 중이 아닙니다. 먼저 sudo tailscale up을 실행하세요." >&2
  exit 1
fi

TAILSCALE_STATE=$(printf '%s' "$TAILSCALE_STATUS" | jq -r '.BackendState // empty')
if [ "$TAILSCALE_STATE" != "Running" ]; then
  echo "Tailscale 상태가 Running이 아닙니다. 먼저 sudo tailscale up을 실행하세요." >&2
  exit 1
fi

if [ ! -d invidious-src/.git ]; then
  git clone --depth 1 https://github.com/iv-org/invidious.git invidious-src
else
  git -C invidious-src pull --ff-only
fi

if [ ! -f .env ]; then
  umask 077
  POSTGRES_PASSWORD=$(openssl rand -hex 24)
  HMAC_KEY=$(openssl rand -hex 32)
  COMPANION_KEY=$(openssl rand -hex 8)
  RELAY_KEY=$(openssl rand -hex 32)
  {
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
echo "Tailscale Funnel을 활성화합니다. 처음이면 출력되는 승인 링크를 여세요."
tailscale funnel --bg --https=443 http://127.0.0.1:8080

TAILSCALE_STATUS=$(tailscale status --json)
TAILSCALE_DOMAIN=$(printf '%s' "$TAILSCALE_STATUS" | jq -r '.Self.DNSName // empty' | sed 's/\.$//')
case "$TAILSCALE_DOMAIN" in
  *.ts.net) ;;
  *)
    echo "Tailscale *.ts.net 이름을 찾지 못했습니다. Funnel 승인 후 다시 실행하세요." >&2
    exit 1
    ;;
esac

echo
echo "컨테이너 상태:"
docker compose ps
echo
tailscale funnel status
echo
echo "Apps Script의 VPS_RELAY_URL: https://$TAILSCALE_DOMAIN"
echo "Apps Script의 RELAY_KEY: $(sed -n 's/^RELAY_KEY=//p' .env)"
echo "이 키가 출력되는 터미널 기록을 안전하게 관리하세요."
