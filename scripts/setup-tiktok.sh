#!/bin/sh
# One-time TikTok setup on Alex's Mac (docs/tiktok-setup.md has the TikTok for Developers steps first).
# The TikTok app "Basics Social" has two sets of credentials: its Sandbox ("Basics Sandbox", for testing
# and recording the audit demo) and Production. This asks which one to use (sandbox first), prompts for
# that Client key and Client secret the first time (the secret is not echoed), stores them in the login
# keychain (service icubasics-social), makes it the active environment, and runs scripts/tiktok-auth.mjs,
# which opens the browser for the TikTok sign-in and stores that account's tokens for that environment.
# Nothing is printed and nothing goes to GitHub: the poster runs on this Mac.
#
#   sh scripts/setup-tiktok.sh                   # asks sandbox or production; the RN Basics account
#   sh scripts/setup-tiktok.sh sandbox           # no question
#   sh scripts/setup-tiktok.sh production rn
#   sh scripts/setup-tiktok.sh icu               # another brand's account, same app
#   sh scripts/setup-tiktok.sh sandbox --new-client   # replace that environment's stored key and secret
#
# Rerun it to sign in again (after 180 days unused, after revoking access in TikTok, or after a refresh
# error), or to switch the poster between sandbox and production.
set -eu
SERVICE="icubasics-social"
cd "$(dirname "$0")/.."
ACCOUNT="rn"
ENV=""
NEW_CLIENT=""
ANY=""
for arg in "$@"; do
  case "$arg" in
    --new-client) NEW_CLIENT=1 ;;
    --any) ANY="--any" ;;
    sandbox|production) ENV="$arg" ;;
    rn|icu|medic) ACCOUNT="$arg" ;;
    *) echo "Unknown argument: $arg (sandbox|production; accounts rn, icu, medic; --new-client, --any)"; exit 1 ;;
  esac
done

if [ -z "$ENV" ]; then
  printf 'Which TikTok credentials? 1 = Sandbox (Basics Sandbox, until the app is approved), 2 = Production [1]: '
  read -r CHOICE
  case "${CHOICE:-1}" in 1|s|sandbox) ENV=sandbox ;; 2|p|production) ENV=production ;; *) echo "Answer 1 or 2."; exit 1 ;; esac
fi
if [ "$ENV" = sandbox ]; then PREFIX="TIKTOK_SANDBOX_"; WHERE="the app page with the toggle on Sandbox, Basics Sandbox > App details > Credentials"
else PREFIX="TIKTOK_"; WHERE="the app page with the toggle on Production > App details > Credentials"; fi

# printf is a shell builtin, so the value never shows up in the process list
store() {
  printf 'add-generic-password -U -s "%s" -a "%s" -w "%s"\n' "$SERVICE" "$1" "$2" | security -i >/dev/null
  security find-generic-password -s "$SERVICE" -a "$1" >/dev/null 2>&1 || { echo "Could not store $1 in the keychain."; exit 1; }
}

if [ -n "$NEW_CLIENT" ] || ! security find-generic-password -s "$SERVICE" -a "${PREFIX}CLIENT_SECRET" >/dev/null 2>&1; then
  echo "The $ENV Client key and Client secret are on $WHERE."
  printf "TikTok $ENV Client key: "; read -r CLIENT_KEY
  printf "TikTok $ENV Client secret (paste, then Enter; it will not be shown): "
  stty -echo; read -r CLIENT_SECRET; stty echo; printf '\n'
  [ -n "$CLIENT_KEY" ] && [ -n "$CLIENT_SECRET" ] || { echo "Both values are required."; exit 1; }
  case "$CLIENT_KEY$CLIENT_SECRET" in *[!A-Za-z0-9_-]*) echo "Unexpected characters in a value (spaces or quotes?); paste it again."; exit 1 ;; esac
  store "${PREFIX}CLIENT_KEY" "$CLIENT_KEY"
  store "${PREFIX}CLIENT_SECRET" "$CLIENT_SECRET"
  echo "Stored ${PREFIX}CLIENT_KEY and ${PREFIX}CLIENT_SECRET in the keychain."
else
  echo "Using the $ENV client key and secret already in the keychain (--new-client replaces them)."
fi
store TIKTOK_ACTIVE_ENV "$ENV"
echo "The poster now uses the $ENV app."
TIKTOK_ENV="$ENV" node scripts/tiktok-auth.mjs "$ACCOUNT" $ANY
