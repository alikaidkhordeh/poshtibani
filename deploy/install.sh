#!/usr/bin/env bash
# Installs, updates or restores the clinic support chat (چت پشتیبانی) in its own folder on this server.
#
# Server rules: nothing is ever deleted, and no other folder, container or service is touched (the
# booking panel in ~/panel-nobatdehi and the server's bots stay exactly as they are).
# Everything lives in $CHAT_DIR (default ~/chat-poshtibani):
#   app/          the chat's code (earlier versions are kept as app.old-*)
#   data/         database and daily backups       .env          settings
#   cloudflared/  tunnel files (tunnel mode)        caddy/        HTTPS certificate (direct mode)
#
# Where the code comes from:
#   - with a GitHub token (CHAT_GITHUB_TOKEN), the latest code of the repository's default branch
#     (or CHAT_BRANCH) is downloaded into app/;
#   - without one, the code already in app/ is used (for example after unpacking a full backup),
#     so the chat can be moved to another server with no GitHub at all.
#
# How the chat is reached:
#   - "tunnel" (default): a Cloudflare tunnel. cloudflared connects out to Cloudflare, so no port is
#     opened on this server (ports 80 and 443 here belong to other programs). The tunnel points the
#     subdomain at itself with its own DNS record. If that subdomain already has a record (for example
#     an A record made by hand), only that one record is replaced, and only with CHAT_DNS_OVERWRITE=1
#     or after the owner answers y.
#   - "direct" (CHAT_MODE=direct): Caddy answers on port 443 only, with a free certificate (port 80 is
#     never used), for a server whose port 443 is free. Needs a Cloudflare DNS "A" record from the
#     subdomain to this server's IP, with the proxy (orange cloud) turned off.
#
# Run it again at any time: data, settings, the tunnel and certificates are kept.
# Overrides: CHAT_HOST=chat.example.com (re-enter the address), CHAT_MODE=tunnel|direct, CHAT_DIR,
# CHAT_BRANCH, CHAT_DNS_OVERWRITE=1 (tunnel), CHAT_SKIP_DNS_CHECK=1 (direct).

main() {
  set -euo pipefail

  local REPO="alikaidkhordeh/poshtibani"
  local DIR="${CHAT_DIR:-$HOME/chat-poshtibani}"
  local CF_IMAGE="cloudflare/cloudflared:2026.9.3"

  # ── Requirements are checked, never installed (installing them would change the server) ──
  command -v docker >/dev/null 2>&1 || fail "Docker روی این سرور نصب نیست. روی یک سرور تازه و خالی این را بزنید:  apt-get update && apt-get install -y docker.io docker-compose-v2 docker-buildx
  روی سروری که برنامه‌های دیگر هم دارد، چیزی نصب نکنید و اول هماهنگ کنید."
  docker compose version >/dev/null 2>&1 || fail "Docker Compose نسخه ۲ پیدا نشد. این را بزنید:  apt-get install -y docker-compose-v2 docker-buildx"

  mkdir -p "$DIR/data"
  cd "$DIR"

  local IS_ROOT=0 CHAT_UID CHAT_GID CF_USER CADDY_USER
  if [ "$(id -u)" = 0 ]; then
    IS_ROOT=1 CHAT_UID=1000 CHAT_GID=1000 CF_USER=65532:65532 CADDY_USER=0:0
  else
    CHAT_UID="$(id -u)" CHAT_GID="$(id -g)" CF_USER="$(id -u):$(id -g)" CADDY_USER="$(id -u):$(id -g)"
  fi

  # ── 1. Code ──
  if [ -n "${CHAT_GITHUB_TOKEN:-}" ] || [ ! -f app/package.json ]; then
    step "۱ از ۴: دریافت آخرین نسخه‌ی کد از گیت‌هاب"
    download_code "$REPO" "${CHAT_BRANCH:-}"
  else
    step "۱ از ۴: استفاده از کدی که همین الان در پوشه هست (بدون گیت‌هاب)"
  fi
  [ -f app/deploy/docker-compose.yml ] || fail "پوشه‌ی app کامل نیست."
  cp app/deploy/docker-compose.yml docker-compose.yml

  # ── 2. Settings (.env) ──
  if [ ! -f .env ]; then
    step "۲ از ۴: ساخت تنظیمات"
    local shown=0
    if [ -f data/chat.sqlite ]; then
      shown=restored
      note "اطلاعات قبلی پیدا شد (بازگردانی از پشتیبان)؛ همان مدیران و رمزهای قبلی کار می‌کنند."
    fi
    local password
    password="$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
    (
      umask 077
      cat > .env <<ENV
OWNER_USERNAME=owner
OWNER_PASSWORD=$password
OWNER_PASSWORD_SHOWN=$shown
OWNER_DISPLAY_NAME=مالک
CHAT_UID=$CHAT_UID
CHAT_GID=$CHAT_GID
CF_USER=$CF_USER
CADDY_USER=$CADDY_USER
BACKUP_KEEP=60
ENV
    )
  else
    step "۲ از ۴: تنظیمات قبلی حفظ شد"
  fi
  if [ "$IS_ROOT" = 1 ]; then chown -R "$CHAT_UID:$CHAT_GID" data; fi

  local MODE="${CHAT_MODE:-$(envget CHAT_MODE)}"
  MODE="${MODE:-tunnel}"
  [ "$MODE" = tunnel ] || [ "$MODE" = direct ] || fail "CHAT_MODE باید tunnel یا direct باشد."
  envset CHAT_MODE "$MODE"
  envset COMPOSE_PROFILES "$MODE"
  if [ "$MODE" = direct ]; then envset TRUST_PROXY proxy; else envset TRUST_PROXY cloudflare; fi

  # ── 3. Address (saved only after it has been checked, so a mistake is fixed by running again) ──
  local HOST="${CHAT_HOST:-$(envget CHAT_HOST)}"
  if [ -z "$HOST" ]; then
    step "۳ از ۴: آدرس صفحه‌ی چت"
    ask HOST "آدرس کامل ساب‌دامین را بنویسید (مثلاً chat.example.com): "
  else
    step "۳ از ۴: آدرس صفحه‌ی چت: $HOST"
  fi
  HOST="${HOST,,}"
  HOST="${HOST//[[:space:]]/}"
  HOST="${HOST#http://}"; HOST="${HOST#https://}"; HOST="${HOST%%/*}"
  [[ "$HOST" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+\.[a-z]{2,}$ ]] \
    || fail "آدرس «$HOST» درست نیست. آدرس کامل ساب‌دامین لازم است، مثلاً chat.example.com. دوباره همین دستور را بزنید."

  if [ "$MODE" = direct ]; then
    mkdir -p caddy/data caddy/config
    check_ports
    check_dns "$HOST" "$DIR"
  else
    note "روش تونل: هیچ پورتی روی سرور باز نمی‌شود و به پورت‌های ۸۰ و ۴۴۳ دست زده نمی‌شود."
    setup_tunnel "$HOST" "$CF_IMAGE" "$CF_USER" "$IS_ROOT" "$DIR"
  fi
  envset CHAT_HOST "$HOST"
  envset PUBLIC_URL "https://$HOST"

  # ── 4. Build and start ──
  step "۴ از ۴: ساخت و اجرای چت (بار اول چند دقیقه طول می‌کشد)"
  note "اگر بیش از ۱۰ دقیقه همین‌جا ماند، Ctrl+C بزنید و خروجی این را بفرستید:  cd $DIR && docker compose logs --tail 60"
  docker compose --profile "$MODE" up -d --build \
    || fail "ساخت یا اجرای چت انجام نشد. اگر خطای شبکه بود همین دستور را دوباره بزنید؛ وگرنه خروجی این را بفرستید:  cd $DIR && docker compose logs --tail 60"
  local STATUS=""
  for _ in $(seq 1 40); do
    STATUS="$(docker inspect -f '{{.State.Health.Status}}' chat-poshtibani 2>/dev/null || true)"
    [ "$STATUS" = healthy ] && break
    sleep 3
  done
  [ "$STATUS" = healthy ] || fail "چت بالا نیامد. خروجی این دستور را بفرستید:  cd $DIR && docker compose logs --tail 60"

  if [ "$MODE" = direct ]; then
    note "در حال گرفتن گواهی امنیتی (https) برای $HOST ..."
    local SECURE=0
    for _ in $(seq 1 30); do
      if curl -fsS --max-time 5 --resolve "$HOST:443:127.0.0.1" "https://$HOST/api/info" >/dev/null 2>&1; then SECURE=1; break; fi
      sleep 3
    done
    if [ "$SECURE" = 0 ]; then
      warn "چت روشن است ولی گواهی https هنوز گرفته نشد. چند دقیقه بعد آدرس را باز کنید."
      warn "اگر باز نشد، خروجی این دستور را بفرستید:  cd $DIR && docker compose logs --tail 60 caddy"
    fi
  else
    note "در حال وصل شدن تونل به Cloudflare ..."
    local LINKED=0
    for _ in $(seq 1 20); do
      # grep -c reads all the logs: with -q, a long log could end in SIGPIPE, which pipefail reports as failure.
      if [ "$(docker logs chat-poshtibani-tunnel 2>&1 | grep -c 'Registered tunnel connection' || true)" -gt 0 ]; then LINKED=1; break; fi
      sleep 3
    done
    if [ "$LINKED" = 1 ]; then
      note "تونل وصل شد."
    else
      warn "چت روشن است ولی تونل هنوز به Cloudflare وصل نشده. چند دقیقه بعد آدرس را باز کنید."
      warn "اگر باز نشد، خروجی این دستور را بفرستید:  cd $DIR && docker compose logs --tail 60 tunnel"
    fi
  fi

  printf '\n\033[1;32m✔ چت آماده است\033[0m\n'
  note "صفحه‌ی چت (برای مراجعه‌کننده‌ها):  https://$HOST"
  note "پنل مدیریت:                        https://$HOST/admin"
  if [ "$MODE" = tunnel ]; then
    note "اگر همین الان باز نشد، چند دقیقه صبر کنید تا رکورد جدید Cloudflare همه‌جا برسد."
  else
    note "آدرس را همیشه با https:// باز کنید (پورت ۸۰ مال برنامه‌ی دیگری است)."
  fi
  if [ "$(envget OWNER_PASSWORD_SHOWN)" = 0 ]; then
    note "نام کاربری مالک:  $(envget OWNER_USERNAME)"
    note "رمز مالک:         $(envget OWNER_PASSWORD)"
    note "این رمز را یادداشت کنید و بعد از اولین ورود، در پنل مدیریت ← «مدیران و امنیت» رمز خودتان را بگذارید."
    envset OWNER_PASSWORD_SHOWN 1
  fi
  note "اگر رمز اولیه‌ی مالک را گم کردید:   grep OWNER_PASSWORD= $DIR/.env"
  note "دیدن وضعیت:                       cd $DIR && docker compose ps"
  note "دیدن خطاها:                       cd $DIR && docker compose logs --tail 60"
  note "خاموش کردن موقت / روشن کردن:      cd $DIR && docker compose stop   /   cd $DIR && docker compose start"
  note "اجرای دوباره (بدون گیت‌هاب):       bash $DIR/app/deploy/install.sh"
  note "به‌روزرسانی از گیت‌هاب:            دستور نصب راهنما را با یک توکن جدید بزنید"
  note "پشتیبان روزانه‌ی اطلاعات:           $DIR/data/backups"
  note "پشتیبان کامل (کد + اطلاعات):        پنل مدیریت ← مدیران و امنیت ← دانلود پشتیبان کامل"
}

step() { printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '  \033[1;33m! %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

# True when there is a terminal to ask the owner on (not the case under cron or a pipe without ssh -t).
has_tty() { (exec </dev/tty) 2>/dev/null; }

# ask VAR "question" [silent]: reads from the terminal unless VAR is already set.
ask() {
  local __var="$1" __q="$2" __val
  if [ -n "${!__var:-}" ]; then return; fi
  has_tty || fail "این مرحله جواب می‌خواهد ولی ترمینالی برای پرسیدن نیست. دستور را در یک ترمینال SSH بزنید."
  if [ "${3:-}" = silent ]; then read -rsp "  $__q" __val </dev/tty; echo; else read -rp "  $__q" __val </dev/tty; fi
  printf -v "$__var" '%s' "$__val"
}

envget() { [ -f .env ] && sed -n "s/^$1=//p" .env | tail -n 1 || true; }

envset() {
  if grep -q "^$1=" .env; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

# Downloads the code into a new folder and switches to it only when the download is complete.
# The previous version is kept as app.old-<time>; nothing is deleted.
download_code() {
  local repo="$1" branch="$2" stamp
  command -v curl >/dev/null 2>&1 || fail "curl پیدا نشد."
  tar --version 2>/dev/null | grep -q 'GNU tar' || fail "GNU tar پیدا نشد."
  ask CHAT_GITHUB_TOKEN "توکن گیت‌هاب (github_pat_...) را بچسبانید و Enter بزنید: " silent
  [ -n "$CHAT_GITHUB_TOKEN" ] || fail "توکن گیت‌هاب خالی است."
  stamp="$(date +%Y%m%d-%H%M%S)"
  mkdir "app.new-$stamp"
  curl -fsSL -H @<(printf 'Authorization: Bearer %s\n' "$CHAT_GITHUB_TOKEN") "https://api.github.com/repos/$repo/tarball${branch:+/$branch}" \
    | tar -xz -C "app.new-$stamp" --strip-components=1 \
    || fail "دریافت کد انجام نشد؛ توکن اشتباه است، تاریخش گذشته، یا poshtibani در آن انتخاب نشده. یک توکن جدید بسازید و دوباره بزنید."
  [ -f "app.new-$stamp/package.json" ] || fail "کد دریافت‌شده کامل نیست."
  if [ -d app ]; then mv app "app.old-$stamp"; fi
  mv "app.new-$stamp" app
  note "کد در $PWD/app به‌روز شد."
}

# Direct mode needs port 443 (port 80 is left alone). Stop, rather than disturb, if another program uses it.
check_ports() {
  if [ -n "$(docker ps -q --filter name=^chat-poshtibani-caddy$ 2>/dev/null)" ]; then return; fi
  if ! command -v ss >/dev/null 2>&1; then
    warn "دستور ss پیدا نشد؛ آزاد بودن پورت ۴۴۳ بررسی نشد."
    return
  fi
  local busy
  busy="$(ss -ltnpH 2>/dev/null | awk '$4 ~ /:443$/' || true)"
  if [ -n "$busy" ]; then
    printf '%s\n' "$busy" >&2
    fail "پورت ۴۴۳ دست برنامه‌ی دیگری روی سرور است و به آن دست نمی‌زنیم. روش تونل پورت نمی‌خواهد؛ همین دستور را با CHAT_MODE=tunnel بزنید."
  fi
}

# The subdomain must point straight at this server (Cloudflare proxy off), or no certificate can be issued.
check_dns() {
  local host="$1" dir="$2" ip public
  [ "${CHAT_SKIP_DNS_CHECK:-}" = 1 ] && return
  ip="$(getent ahostsv4 "$host" 2>/dev/null | awk 'NR==1 {print $1}' || true)"
  if [ -z "$ip" ]; then
    # The server's own resolver may remember "not found" for a while; ask Cloudflare's resolver directly.
    ip="$(curl -fsS --max-time 8 -H 'accept: application/dns-json' "https://cloudflare-dns.com/dns-query?name=$host&type=A" 2>/dev/null \
      | grep -o '"data":"[0-9.]*"' | head -n 1 | cut -d'"' -f4 || true)"
  fi
  [ -n "$ip" ] || fail "رکورد $host در Cloudflare پیدا نشد. رکورد A را بسازید (پروکسی خاموش)، حدود ۵ دقیقه صبر کنید و دوباره بزنید:
    CHAT_HOST=$host bash $dir/app/deploy/install.sh
  اگر آدرس اشتباه است، همین دستور را با آدرس درست بزنید."
  if hostname -I 2>/dev/null | tr ' ' '\n' | grep -qxF "$ip"; then
    note "رکورد $host درست به این سرور اشاره می‌کند."
    return
  fi
  public="$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
  if [ -n "$public" ] && [ "$ip" = "$public" ]; then
    note "رکورد $host درست به این سرور اشاره می‌کند."
    return
  fi
  fail "رکورد $host به $ip اشاره می‌کند، نه به این سرور${public:+ ($public)}. در Cloudflare، IP رکورد را IP همین سرور بگذارید و پروکسی (ابر نارنجی) را خاموش کنید (DNS only). اگر همین الان عوضش کرده‌اید، حدود ۵ دقیقه صبر کنید و دوباره بزنید:
    CHAT_HOST=$host bash $dir/app/deploy/install.sh
  اگر مطمئنید رکورد درست است:  CHAT_SKIP_DNS_CHECK=1 CHAT_HOST=$host bash $dir/app/deploy/install.sh"
}

# Tunnel mode: one-time Cloudflare login link, then a tunnel and its DNS record.
setup_tunnel() {
  local host="$1" image="$2" cf_user="$3" is_root="$4" dir="$5"
  mkdir -p cloudflared
  if [ "$is_root" = 1 ]; then chown 65532:65532 cloudflared; fi
  chmod 700 cloudflared
  if [ -f cloudflared/config.yml ] && grep -qxF "  - hostname: $host" cloudflared/config.yml; then return; fi
  local cf=(docker run --rm --user "$cf_user" -e HOME=/home/nonroot -v "$PWD/cloudflared:/home/nonroot/.cloudflared" "$image")
  if [ ! -f cloudflared/cert.pem ]; then
    note "یک لینک نشان داده می‌شود: آن را در مرورگری باز کنید که وارد Cloudflare هستید،"
    note "دامنه را انتخاب کنید و Authorize بزنید. این‌جا خودش ادامه پیدا می‌کند."
    "${cf[@]}" tunnel login || fail "ورود به Cloudflare انجام نشد؛ دوباره بزنید:  CHAT_HOST=$host bash $dir/app/deploy/install.sh"
  fi
  local cred
  cred="$(find cloudflared -maxdepth 1 -name '*.json' | head -n 1)"
  if [ -z "$cred" ]; then
    # A per-server name, so a second server (or a restore) never collides with an existing tunnel.
    "${cf[@]}" tunnel create "chat-poshtibani-$(hostname -s)-$(date +%Y%m%d%H%M%S)" \
      || fail "ساخت تونل Cloudflare انجام نشد. خروجی بالا را بفرستید."
    cred="$(find cloudflared -maxdepth 1 -name '*.json' | head -n 1)"
  fi
  [ -n "$cred" ] || fail "ساخت تونل Cloudflare انجام نشد."
  local id
  id="$(basename "$cred" .json)"
  route_dns "$id" "$host" "$dir" "${cf[@]}"
  if [ -f cloudflared/config.yml ]; then mv cloudflared/config.yml "cloudflared/config.yml.old-$(date +%Y%m%d-%H%M%S)"; fi
  cat > cloudflared/config.yml <<CFG
tunnel: $id
credentials-file: /home/nonroot/.cloudflared/$id.json
ingress:
  - hostname: $host
    service: http://chat:3000
  - service: http_status:404
CFG
  if [ "$is_root" = 1 ]; then chown 65532:65532 cloudflared/config.yml; fi
}

# Points the subdomain at the tunnel. The first try never replaces anything; when the subdomain already
# has a record (the owner's A record, for example), that one record is replaced only with
# CHAT_DNS_OVERWRITE=1 or the owner's "y". No other hostname is ever named, so no other record changes.
route_dns() {
  local id="$1" host="$2" dir="$3"
  shift 3
  if "$@" tunnel route dns "$id" "$host"; then return; fi
  warn "رکورد $host ساخته نشد (پیام بالا). معمولاً یعنی این ساب‌دامین از قبل در Cloudflare رکورد دارد، مثلاً همان رکورد A که دستی ساخته شد."
  note "روش تونل رکورد خودش را لازم دارد: رکورد فعلی $host (فقط همین یک ساب‌دامین) با رکورد تونل جایگزین می‌شود."
  note "به هیچ رکورد دیگری از دامنه دست زده نمی‌شود."
  local answer=""
  if [ "${CHAT_DNS_OVERWRITE:-}" = 1 ]; then
    note "CHAT_DNS_OVERWRITE=1 داده شده؛ رکورد $host جایگزین می‌شود."
    answer=y
  elif has_tty; then
    read -rp "  رکورد $host جایگزین شود؟ (y/n): " answer </dev/tty || answer=""
  fi
  case "$answer" in
    y | Y | yes | YES) ;;
    *) fail "رکورد $host عوض نشد و نصب متوقف شد. برای جایگزین کردن همین یک رکورد این را بزنید:
    CHAT_DNS_OVERWRITE=1 CHAT_HOST=$host bash $dir/app/deploy/install.sh
  یا یک ساب‌دامین دیگر بدهید:  CHAT_HOST=chat2.example.com bash $dir/app/deploy/install.sh" ;;
  esac
  "$@" tunnel route dns --overwrite-dns "$id" "$host" \
    || fail "جایگزین کردن رکورد $host انجام نشد. خروجی بالا را بفرستید."
  note "رکورد $host حالا به تونل اشاره می‌کند."
}

# Everything above is only definitions; bash has read up to this line before main runs, so replacing
# app/deploy/install.sh while it runs is safe.
main "$@"; exit $?
