#!/bin/sh
# Stores an Instagram account's user ID and access token in the Mac's login keychain (service
# icubasics-social) for scripts/analytics.mjs, which runs only on this Mac because insights are
# private and this repository is public. The token is not echoed, never goes on a command line, and
# is checked read-only against the API (account lookup and an insights read) before it is stored.
#
#   sh scripts/setup-keychain.sh        # @icubasics   (IG_USER_ID, IG_ACCESS_TOKEN)
#   sh scripts/setup-keychain.sh rn     # @rnbasicsnclex (IG_USER_ID_RN, IG_ACCESS_TOKEN_RN)
#   sh scripts/setup-keychain.sh medic  # @themedicbasics (IG_USER_ID_MEDIC, IG_ACCESS_TOKEN_MEDIC)
#
# The token can be the one the posting job uses or a new one from the Meta dashboard (Instagram →
# API setup with Instagram business login → Generate token); it needs instagram_business_basic and
# instagram_business_manage_insights. analytics.mjs refreshes it in the keychain every week. The
# YouTube credentials go in with scripts/setup-youtube.sh.
set -eu
SERVICE="icubasics-social"
BRAND="${1:-icu}"
case "$BRAND" in
  icu) SUFFIX=""; DEFAULT_ID=""; HANDLE="@icubasics" ;;
  rn)  SUFFIX="_RN"; DEFAULT_ID="17841429422921068"; HANDLE="@rnbasicsnclex" ;;
  medic) SUFFIX="_MEDIC"; DEFAULT_ID=""; HANDLE="@themedicbasics" ;;
  *) echo "Unknown brand '$BRAND' (icu, rn or medic)"; exit 1 ;;
esac
echo "Storing analytics credentials for $HANDLE in the keychain"
if [ -n "$DEFAULT_ID" ]; then
  printf 'Instagram user ID [%s]: ' "$DEFAULT_ID"; read -r IG_USER_ID; IG_USER_ID="${IG_USER_ID:-$DEFAULT_ID}"
else
  printf 'Instagram user ID (shown next to the token in the Meta dashboard): '; read -r IG_USER_ID
fi
printf 'Instagram access token (paste, then Enter; it will not be shown): '
stty -echo; read -r IG_ACCESS_TOKEN; stty echo; printf '\n'
[ -n "$IG_USER_ID" ] && [ -n "$IG_ACCESS_TOKEN" ] || { echo "Both values are required."; exit 1; }
case "$IG_USER_ID" in *[!0-9]*) echo "The Instagram user ID is a number (it looks like a token was pasted there)."; exit 1 ;; esac
case "$IG_ACCESS_TOKEN" in *[\ \"\\]*) echo "Unexpected spaces or quotes in the token; paste it again."; exit 1 ;; esac

# curl reads the URL from stdin (-K -), so the token stays off the command line
get() { printf 'url = "https://graph.instagram.com/v25.0/%s&access_token=%s"\n' "$1" "$IG_ACCESS_TOKEN" | curl -s -K -; }
ME=$(get "me?fields=user_id,username")
case "$ME" in
  *username*) echo "Token check: $ME" ;;
  *) echo "Token check failed: $ME"; exit 1 ;;
esac
INS=$(get "$IG_USER_ID/insights?metric=reach&period=day&metric_type=total_value")
case "$INS" in
  *'"data"'*) echo "Insights check: OK" ;;
  *) echo "Insights check failed (the token needs instagram_business_manage_insights): $INS"; exit 1 ;;
esac

for pair in "IG_USER_ID$SUFFIX:$IG_USER_ID" "IG_ACCESS_TOKEN$SUFFIX:$IG_ACCESS_TOKEN"; do
  NAME="${pair%%:*}"; VALUE="${pair#*:}"
  printf 'add-generic-password -U -s "%s" -a "%s" -w "%s"\n' "$SERVICE" "$NAME" "$VALUE" | security -i >/dev/null
  security find-generic-password -s "$SERVICE" -a "$NAME" >/dev/null 2>&1 || { echo "Could not store $NAME."; exit 1; }
done
echo "Stored IG_USER_ID$SUFFIX and IG_ACCESS_TOKEN$SUFFIX in the keychain. Test: node scripts/analytics.mjs fetch"
