#!/bin/sh
# One-time YouTube setup on Alex's Mac (docs/youtube-setup.md has the Google Cloud steps first).
# Prompts for the Desktop OAuth client's ID and secret (the secret is not echoed), stores both in
# the login keychain (service icubasics-social), then runs scripts/youtube-auth.mjs, which opens the
# browser for the sign-in and stores the channel's refresh token in the keychain too. Nothing is
# printed and nothing goes to GitHub: the YouTube scheduler and the analytics both run on this Mac.
#
#   sh scripts/setup-youtube.sh                     # @TheRNBasics (YT_REFRESH_TOKEN)
#   sh scripts/setup-youtube.sh --channel rheafi    # @Rheafi (YT_REFRESH_TOKEN_RHEAFI)
#
# Every channel uses the same OAuth client. With --channel rheafi the client already in the keychain
# is reused (it asks for it only when none is stored); the RN sign-in is never touched.
# Rerun it to sign in again (for example after adding a scope, or after an invalid_grant error).
set -eu
SERVICE="icubasics-social"
cd "$(dirname "$0")/.."

CHANNEL="rn"
case "${1:-}" in
  "") ;;
  --channel) CHANNEL="${2:-}" ;;
  --channel=*) CHANNEL="${1#--channel=}" ;;
  *) echo "Usage: sh scripts/setup-youtube.sh [--channel rn|rheafi]"; exit 1 ;;
esac
case "$CHANNEL" in rn|rheafi) ;; *) echo "--channel must be rn or rheafi"; exit 1 ;; esac

# printf is a shell builtin, so the value never shows up in the process list
store() {
  printf 'add-generic-password -U -s "%s" -a "%s" -w "%s"\n' "$SERVICE" "$1" "$2" | security -i >/dev/null
  security find-generic-password -s "$SERVICE" -a "$1" >/dev/null 2>&1 || { echo "Could not store $1 in the keychain."; exit 1; }
}
have() { security find-generic-password -s "$SERVICE" -a "$1" >/dev/null 2>&1; }

if [ "$CHANNEL" != "rn" ] && have YT_CLIENT_ID && have YT_CLIENT_SECRET; then
  echo "Using the OAuth client already in the keychain (YT_CLIENT_ID, YT_CLIENT_SECRET)."
else
  printf 'OAuth client ID (ends in .apps.googleusercontent.com): '; read -r YT_CLIENT_ID
  printf 'OAuth client secret (paste, then Enter; it will not be shown): '
  stty -echo; read -r YT_CLIENT_SECRET; stty echo; printf '\n'
  [ -n "$YT_CLIENT_ID" ] && [ -n "$YT_CLIENT_SECRET" ] || { echo "Both values are required."; exit 1; }
  case "$YT_CLIENT_ID" in *.apps.googleusercontent.com) ;; *) echo "That does not look like a client ID (it ends in .apps.googleusercontent.com)."; exit 1 ;; esac
  case "$YT_CLIENT_SECRET$YT_CLIENT_ID" in *[\ \"\\]*) echo "Unexpected spaces or quotes in a value; paste it again."; exit 1 ;; esac
  store YT_CLIENT_ID "$YT_CLIENT_ID"
  store YT_CLIENT_SECRET "$YT_CLIENT_SECRET"
  echo "Stored YT_CLIENT_ID and YT_CLIENT_SECRET in the keychain."
fi
node scripts/youtube-auth.mjs --channel "$CHANNEL"
