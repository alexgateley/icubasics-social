# ICU Basics · Question of the Day

Rendered Instagram posts for [@icubasics](https://www.instagram.com/icubasics), served from
GitHub Pages, and a daily GitHub Actions job that publishes each day's carousel at 7:00 AM Central.

The posts are generated from the [ICU Basics](https://apps.apple.com/app/id6809866200) question
banks by `scripts/social/push-month.sh` in the app repo, which renders a month of slides and
pushes them here.

```
posts/<date>-<exam>/1-question.jpg   slide 1
posts/<date>-<exam>/2-answer.jpg     slide 2
posts/<date>-<exam>/caption.txt      caption with hashtags
posts/index.json                     date → folder
published/<date>.json                written by the job after posting (prevents double posts)
```

## One-time setup

1. **GitHub Pages:** repo Settings → Pages → Source "Deploy from a branch", branch `main`, folder `/ (root)`.
   Images are then served at `https://alexgateley.github.io/icubasics-social/posts/...`.
2. **Meta app:** at developers.facebook.com create an app, add the **Instagram** product, choose
   "API setup with Instagram login", add the @icubasics professional account, and generate a token.
   Copy the **Instagram user ID** and the **access token** it shows.
3. **Secrets:** repo Settings → Secrets and variables → Actions:
   - `IG_USER_ID` – the Instagram user id
   - `IG_ACCESS_TOKEN` – the long-lived token (60 days)
   - `GH_PAT` (optional but recommended) – a fine-grained personal access token for this repo with
     *Secrets: Read and write*, so the job can store the refreshed token every Sunday. Without it,
     regenerate the token in the Meta dashboard every 60 days.
4. **Test:** Actions → "Post Question of the Day" → Run workflow with `dry_run` checked, then once
   more with a `date` to post for real.

## Every month

In the app repo: `scripts/social/push-month.sh 2026-12-01 31`. It renders the posts, copies them
here, updates `index.json`, and pushes. The job picks them up on their dates.

## Notes

- The job runs at 12:07 and 13:07 UTC; the script posts only when it is 7 AM in Chicago, which
  handles daylight saving time.
- If a day has no folder in `index.json`, the job logs that and does nothing.
- To skip a day, delete its folder before 7 AM. To re-post a day, delete `published/<date>.json`
  and run the workflow with that date.
