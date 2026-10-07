#!/bin/sh
# Kicks the "Post Question of the Day" GitHub workflow from this Mac. GitHub's own cron schedule
# fires hours late or not at all on a quiet repository, so a launchd agent runs this at 7:05 and
# 9:05 AM Chicago (see launchd/com.icubasics.qotd.plist). The workflow itself decides whether to
# post: it publishes today's post once (a marker file in published/ prevents duplicates) and only
# from 7 AM Chicago onward, so extra kicks are harmless. Needs the GitHub CLI logged in as the
# repository owner (gh auth status).
#
#   kick-post.sh            # Question of the Day (launchd/com.icubasics.qotd.plist)
#   kick-post.sh feature    # evening feature Reel (launchd/com.icubasics.feature.plist, 6:05 and 8:05 PM Chicago)
set -u
KIND="${1:-qotd}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
REPO="alexgateley/icubasics-social"
LOG="$HOME/Library/Logs/icubasics-qotd.log"
mkdir -p "$(dirname "$LOG")"
stamp() { date '+%Y-%m-%d %H:%M:%S %Z'; }

# Wait briefly for the network after wake-up
n=0
until curl -s -o /dev/null --max-time 5 https://api.github.com/ || [ $n -ge 12 ]; do n=$((n+1)); sleep 10; done

if out=$(gh workflow run "Post Question of the Day" --repo "$REPO" -f dry_run=false -f kind="$KIND" 2>&1); then
  echo "$(stamp) kicked $KIND: $out" >> "$LOG"
else
  echo "$(stamp) FAILED to kick $KIND: $out" >> "$LOG"
  exit 1
fi
