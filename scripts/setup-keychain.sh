#!/bin/sh
# Stores an Instagram account's user ID and access token in the Mac's login keychain (service
# icubasics-social) for scripts/analytics.mjs, which runs only on this Mac because insights are
# private and this repository is public. The token is not echoed, never goes on a command line, and
# is checked read-only against the API (account lookup and an insights read) before it is stored.
#
#   sh scripts/setup-keychain.sh            # @icubasics        (IG_USER_ID, IG_ACCESS_TOKEN)
#   sh scripts/setup-keychain.sh rn         # @rnbasicsnclex    (IG_USER_ID_RN, IG_ACCESS_TOKEN_RN)
#   sh scripts/setup-keychain.sh medic      # @themedicbasics   (IG_USER_ID_MEDIC, IG_ACCESS_TOKEN_MEDIC)
#   sh scripts/setup-keychain.sh rhea       # @runonrhea        (IG_USER_ID_RHEA, IG_ACCESS_TOKEN_RHEA)
#   sh scripts/setup-keychain.sh winery     # @thewinerybooks   (IG_USER_ID_WINERY, IG_ACCESS_TOKEN_WINERY)
#   sh scripts/setup-keychain.sh franchifi  # @franchifi        (IG_USER_ID_FRANCHIFI, IG_ACCESS_TOKEN_FRANCHIFI)
#   sh scripts/setup-keychain.sh gripwheels # @griptheorywheels (IG_USER_ID_GRIPWHEELS, IG_ACCESS_TOKEN_GRIPWHEELS)
#   sh scripts/setup-keychain.sh all        # all seven in turn; an empty Enter at a token prompt skips that account
#
# The user ID is filled in (press Enter to keep it), so only the token needs pasting. The token can
# be the one the posting job uses or a new one from the Meta dashboard (Instagram → API setup with
# Instagram business login → Generate token); it needs instagram_business_basic and
# instagram_business_manage_insights. analytics.mjs refreshes it in the keychain every week. The
# YouTube credentials go in with scripts/setup-youtube.sh.
set -eu
# KEYCHAIN_SERVICE exists only so tests can use throwaway items (as in keychain.mjs)
SERVICE="${KEYCHAIN_SERVICE:-icubasics-social}"
ALL="icu rn medic rhea winery franchifi gripwheels"

# account -> keychain suffix, Instagram user ID (not secret; from the Meta dashboard), handle.
# Keep in step with IG_ACCOUNTS in analytics.mjs.
info() {
  case "$1" in
    icu)        SUFFIX="";            DEFAULT_ID="17841423460793482"; HANDLE="@icubasics" ;;
    rn)         SUFFIX="_RN";         DEFAULT_ID="17841429422921068"; HANDLE="@rnbasicsnclex" ;;
    medic)      SUFFIX="_MEDIC";      DEFAULT_ID="17841420840594491"; HANDLE="@themedicbasics" ;;
    rhea)       SUFFIX="_RHEA";       DEFAULT_ID="17841426819974871"; HANDLE="@runonrhea" ;;
    winery)     SUFFIX="_WINERY";     DEFAULT_ID="17841433053134440"; HANDLE="@thewinerybooks" ;;
    franchifi)  SUFFIX="_FRANCHIFI";  DEFAULT_ID="17841451921105656"; HANDLE="@franchifi" ;;
    gripwheels) SUFFIX="_GRIPWHEELS"; DEFAULT_ID="17841425472380435"; HANDLE="@griptheorywheels" ;;
    *) return 1 ;;
  esac
}

# Turn echo back on if the script stops while the token prompt is hidden
trap 'stty echo 2>/dev/null || true' EXIT
trap 'stty echo 2>/dev/null || true; exit 130' INT TERM

# curl reads the URL from stdin (-K -), so the token stays off the command line
get() { printf 'url = "https://graph.instagram.com/v25.0/%s&access_token=%s"\n' "$1" "$IG_ACCESS_TOKEN" | curl -s -K -; }

# setup_one <account> <skippable 0|1>; returns 0 stored, 2 skipped, 1 failed
setup_one() {
  info "$1"
  echo ""
  echo "== $HANDLE  (keychain: IG_USER_ID$SUFFIX, IG_ACCESS_TOKEN$SUFFIX)"
  printf 'Instagram user ID [%s] (Enter keeps it): ' "$DEFAULT_ID"; read -r IG_USER_ID || IG_USER_ID=""
  IG_USER_ID="${IG_USER_ID:-$DEFAULT_ID}"
  if [ "$2" = 1 ]; then
    printf 'Access token for %s (paste, then Enter; not shown; empty Enter skips): ' "$HANDLE"
  else
    printf 'Access token for %s (paste, then Enter; it will not be shown): ' "$HANDLE"
  fi
  stty -echo 2>/dev/null || true; read -r IG_ACCESS_TOKEN || IG_ACCESS_TOKEN=""; stty echo 2>/dev/null || true; printf '\n'
  if [ -z "$IG_ACCESS_TOKEN" ]; then
    if [ "$2" = 1 ]; then echo "Skipped $HANDLE."; return 2; fi
    echo "A token is required."; return 1
  fi
  case "$IG_USER_ID" in *[!0-9]*) echo "The Instagram user ID is a number (it looks like a token was pasted there)."; return 1 ;; esac
  case "$IG_ACCESS_TOKEN" in *[\ \"\\]*) echo "Unexpected spaces or quotes in the token; paste it again."; return 1 ;; esac

  ME=$(get "me?fields=user_id,username")
  case "$ME" in
    *username*) echo "Token check: $ME" ;;
    *) echo "Token check failed: $ME"; return 1 ;;
  esac
  case "$ME" in
    *"$IG_USER_ID"*) : ;;
    *) echo "Note: that token is not for user ID $IG_USER_ID; check that it is the token for $HANDLE." ;;
  esac
  INS=$(get "$IG_USER_ID/insights?metric=reach&period=day&metric_type=total_value")
  case "$INS" in
    *'"data"'*) echo "Insights check: OK" ;;
    *) echo "Insights check failed (the token needs instagram_business_manage_insights): $INS"; return 1 ;;
  esac

  for pair in "IG_USER_ID$SUFFIX:$IG_USER_ID" "IG_ACCESS_TOKEN$SUFFIX:$IG_ACCESS_TOKEN"; do
    NAME="${pair%%:*}"; VALUE="${pair#*:}"
    printf 'add-generic-password -U -s "%s" -a "%s" -w "%s"\n' "$SERVICE" "$NAME" "$VALUE" | security -i >/dev/null
    security find-generic-password -s "$SERVICE" -a "$NAME" >/dev/null 2>&1 || { echo "Could not store $NAME."; return 1; }
  done
  IG_ACCESS_TOKEN=""; VALUE=""
  echo "Stored IG_USER_ID$SUFFIX and IG_ACCESS_TOKEN$SUFFIX in the keychain."
  return 0
}

ACCOUNT="${1:-icu}"
if [ "$ACCOUNT" = all ]; then
  echo "Storing analytics credentials for all seven Instagram accounts. Press Enter at a token prompt to skip one."
  STORED=""; SKIPPED=""; FAILED=""
  for a in $ALL; do
    rc=0; setup_one "$a" 1 || rc=$?
    case "$rc" in 0) STORED="$STORED $a" ;; 2) SKIPPED="$SKIPPED $a" ;; *) FAILED="$FAILED $a" ;; esac
  done
  echo ""
  echo "Stored:${STORED:- none}"
  echo "Skipped:${SKIPPED:- none}"
  echo "Failed:${FAILED:- none}${FAILED:+  (rerun one with: sh scripts/setup-keychain.sh <name>)}"
  echo "Test: node scripts/analytics.mjs fetch"
  [ -z "$FAILED" ] || exit 1
  exit 0
fi
info "$ACCOUNT" || { echo "Unknown account '$ACCOUNT' (one of: $ALL, or all)"; exit 1; }
setup_one "$ACCOUNT" 0 || exit 1
echo "Test: node scripts/analytics.mjs fetch"
