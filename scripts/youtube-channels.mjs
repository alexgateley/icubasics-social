// The YouTube channels the Mac scheduler serves, chosen with --channel (default rn). Every channel
// shares the one Google Cloud OAuth client (YT_CLIENT_ID / YT_CLIENT_SECRET in the keychain) and has
// its own refresh token, kit folder, state file, channel check and description rules.
//
//   rn      @TheRNBasics  YT_REFRESH_TOKEN         ~/Desktop/YouTube Uploads - TheRNBasics/
//                         ~/basics-growth-work/youtube/uploaded.json         Basics rules (three app links)
//   rheafi  @Rheafi       YT_REFRESH_TOKEN_RHEAFI  ~/Desktop/YouTube Uploads - Rheafi/
//                         ~/basics-growth-work/youtube/uploaded-rheafi.json  Rhea rules (scripts/youtube-text.mjs)
import os from 'node:os';
import path from 'node:path';

export const RHEAFI_CHANNEL_ID = 'UCy8LlkL5MwWqEeh7Jj3CYow';

export const CHANNELS = {
  rn: {
    key: 'rn',
    handle: '@TheRNBasics',
    pick: 'TheRNBasics',
    tokenAccount: 'YT_REFRESH_TOKEN',
    uploadsDir: path.join(os.homedir(), 'Desktop/YouTube Uploads - TheRNBasics'),
    stateFile: path.join(os.homedir(), 'basics-growth-work/youtube/uploaded.json'),
    rules: 'basics',
    setup: 'sh scripts/setup-youtube.sh',
    // The RN channel is recognized by its name, as it always has been
    matches: (ch) => /rn\s*basics/i.test(`${ch.snippet?.title ?? ''} ${ch.snippet?.customUrl ?? ''}`),
  },
  rheafi: {
    key: 'rheafi',
    handle: '@Rheafi',
    pick: 'Rheafi',
    tokenAccount: 'YT_REFRESH_TOKEN_RHEAFI',
    uploadsDir: path.join(os.homedir(), 'Desktop/YouTube Uploads - Rheafi'),
    stateFile: path.join(os.homedir(), 'basics-growth-work/youtube/uploaded-rheafi.json'),
    rules: 'rhea',
    setup: 'sh scripts/setup-youtube.sh --channel rheafi',
    // Only the exact channel id counts
    matches: (ch) => ch.id === RHEAFI_CHANNEL_ID,
  },
};

/** Takes --channel <name> or --channel=<name> out of argv: { channel, rest }. Unknown names throw. */
export function channelFromArgs(argv) {
  const rest = [];
  let key = 'rn';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--channel') { key = argv[++i] ?? ''; continue; }
    if (a.startsWith('--channel=')) { key = a.slice('--channel='.length); continue; }
    rest.push(a);
  }
  const channel = CHANNELS[key.toLowerCase()];
  if (!channel) throw new Error(`--channel must be one of ${Object.keys(CHANNELS).join(', ')} (got "${key}")`);
  return { channel, rest };
}
