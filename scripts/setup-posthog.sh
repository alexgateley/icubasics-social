#!/bin/sh
# Stores a PostHog personal API key (read-only: Query Read + Project Read) in the Mac's login keychain
# (service icubasics-social, items POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID) for the Basics Social app.
# The key is not echoed, never goes on a command line, and is checked read-only before it is stored.
#   sh scripts/setup-posthog.sh   (also: sh scripts/setup-keychain.sh posthog)
set -eu
SERVICE="${KEYCHAIN_SERVICE:-icubasics-social}"
HOST="https://us.posthog.com"
DEFAULT_PROJECT="636811"
trap 'stty echo 2>/dev/null || true' EXIT
trap 'stty echo 2>/dev/null || true; exit 130' INT TERM

printf 'PostHog project ID [%s] (Enter keeps it): ' "$DEFAULT_PROJECT"; read -r PID || PID=""
PID="${PID:-$DEFAULT_PROJECT}"
case "$PID" in *[!0-9]*) echo "The project ID is a number."; exit 1 ;; esac
printf 'PostHog personal API key (paste, then Enter; it will not be shown): '
stty -echo 2>/dev/null || true; read -r KEY || KEY=""; stty echo 2>/dev/null || true; printf '\n'
[ -n "$KEY" ] || { echo "A key is required."; exit 1; }
case "$KEY" in *[\ \"\\]*) echo "Unexpected spaces or quotes in the key; paste it again."; exit 1 ;; esac

# header and URL go to curl on stdin so the key stays off the command line
RES=$(printf 'url = "%s/api/projects/%s/"\nheader = "Authorization: Bearer %s"\n' "$HOST" "$PID" "$KEY" | curl -s -K -)
case "$RES" in
  *'"name"'*) echo "Key check: OK, project $(printf '%s' "$RES" | sed -n 's/.*"name": *"\([^"]*\)".*/\1/p' | head -1)" ;;
  *) echo "Key check failed (the key needs Project: Read and Query: Read for project $PID): $(printf '%s' "$RES" | head -c 300)"; exit 1 ;;
esac
Q='{"query":{"kind":"HogQLQuery","query":"select count() from events where timestamp > now() - interval 1 day"}}'
QR=$(printf 'url = "%s/api/projects/%s/query/"\nheader = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\ndata = "%s"\n' "$HOST" "$PID" "$KEY" "$(printf '%s' "$Q" | sed 's/"/\\"/g')" | curl -s -K -)
case "$QR" in
  *'"results"'*) echo "Query check: OK (events in the last day: $(printf '%s' "$QR" | sed -n 's/.*"results": *\[\[\([0-9]*\)\]\].*/\1/p'))" ;;
  *) echo "Query check failed (the key needs Query: Read): $(printf '%s' "$QR" | head -c 300)"; exit 1 ;;
esac

for pair in "POSTHOG_PROJECT_ID:$PID" "POSTHOG_PERSONAL_API_KEY:$KEY"; do
  NAME="${pair%%:*}"; VALUE="${pair#*:}"
  printf 'add-generic-password -U -s "%s" -a "%s" -w "%s"\n' "$SERVICE" "$NAME" "$VALUE" | security -i >/dev/null
  security find-generic-password -s "$SERVICE" -a "$NAME" >/dev/null 2>&1 || { echo "Could not store $NAME."; exit 1; }
done
KEY=""; VALUE=""
echo "Stored POSTHOG_PROJECT_ID and POSTHOG_PERSONAL_API_KEY in the keychain."
