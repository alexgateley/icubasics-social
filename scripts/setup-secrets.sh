#!/bin/sh
# Stores the Instagram credentials as GitHub Actions secrets for the posting job, without the
# values ever appearing in a terminal history or chat. Run it from any directory:
#
#   sh scripts/setup-secrets.sh        # @icubasics   (IG_USER_ID, IG_ACCESS_TOKEN)
#   sh scripts/setup-secrets.sh rn     # @rnbasicsnclex (IG_USER_ID_RN, IG_ACCESS_TOKEN_RN)
#
# It prompts for the Instagram user ID and the access token (the token is not echoed), then
# optionally for a fine-grained GitHub personal access token (GH_PAT, shared by both accounts)
# that lets the job store the weekly refreshed Instagram tokens. Needs the GitHub CLI logged in.
set -eu
REPO="alexgateley/icubasics-social"
BRAND="${1:-icu}"
case "$BRAND" in
  icu) SUFFIX=""; DEFAULT_ID=""; HANDLE="@icubasics" ;;
  rn)  SUFFIX="_RN"; DEFAULT_ID="17841429422921068"; HANDLE="@rnbasicsnclex" ;;
  *) echo "Unknown brand '$BRAND' (icu or rn)"; exit 1 ;;
esac
echo "Storing credentials for $HANDLE"
if [ -n "$DEFAULT_ID" ]; then
  printf 'Instagram user ID [%s]: ' "$DEFAULT_ID"; read -r IG_USER_ID; IG_USER_ID="${IG_USER_ID:-$DEFAULT_ID}"
else
  printf 'Instagram user ID (shown next to the token in the Meta dashboard): '; read -r IG_USER_ID
fi
printf 'Instagram access token (paste, then Enter; it will not be shown): '
stty -echo; read -r IG_ACCESS_TOKEN; stty echo; printf '\n'
[ -n "$IG_USER_ID" ] && [ -n "$IG_ACCESS_TOKEN" ] || { echo "Both values are required."; exit 1; }
# Check the token works before storing it
ME=$(curl -s "https://graph.instagram.com/v25.0/me?fields=user_id,username&access_token=$IG_ACCESS_TOKEN")
case "$ME" in
  *username*) echo "Token check: $ME" ;;
  *) echo "Token check failed: $ME"; exit 1 ;;
esac
printf '%s' "$IG_USER_ID" | gh secret set "IG_USER_ID$SUFFIX" --repo "$REPO"
printf '%s' "$IG_ACCESS_TOKEN" | gh secret set "IG_ACCESS_TOKEN$SUFFIX" --repo "$REPO"
echo "Stored IG_USER_ID$SUFFIX and IG_ACCESS_TOKEN$SUFFIX."
printf 'GitHub fine-grained token for automatic refresh (optional, Enter to skip; not shown): '
stty -echo; read -r GH_PAT; stty echo; printf '\n'
if [ -n "$GH_PAT" ]; then
  printf '%s' "$GH_PAT" | gh secret set GH_PAT --repo "$REPO"
  echo "Stored GH_PAT."
else
  echo "Skipped GH_PAT: regenerate the Instagram token in the Meta dashboard before it expires (60 days)."
fi
echo "Done. Test with: gh workflow run \"Post Question of the Day\" --repo $REPO -f brand=$BRAND -f dry_run=true"
