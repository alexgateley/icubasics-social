// Reads the upload.txt in each upload kit ("~/Desktop/YouTube Uploads - TheRNBasics/", or
// "~/Desktop/YouTube Uploads - Rheafi/" with --channel rheafi) for youtube-schedule.mjs, and checks the
// text against YouTube's limits and the channel's description rules (rules 'basics' or 'rhea').
// The parts it uses (every other line is a note for Alex and is ignored):
//
//   SCHEDULE: Friday, November 6, 2026 at 9:05 AM Pacific (PT)
//   VIDEO FILE: short - RN Basics.mp4  (0:59, 1080x1920, RN Basics end card)
//   ==== TITLE (100 characters; max 100) ====
//   <one line>
//   ==== DESCRIPTION (paste everything between the lines) ====
//   <every line>
//   ==== END OF DESCRIPTION ====
//   ==== TAGS (Show more > Tags; paste) ====
//   <comma-separated tags>
//   ==== SETTINGS ====
//   Related video: <long's title>  (<note>)   or   none (it is a long) / none (long not made yet)
//   Playlist suggestion: <playlist> + <playlist> ...

// Every description links all three apps (Alex, 2026-10-28); these are the App Store ids in the block
export const APP_IDS = { icu: 'id6809866200', rn: 'id6817038868', medic: 'id6817189556' };

// Rhea (Rheafi channel) rules: no "AI" word, at most five hashtags, this line in every description,
// and no app store mention (README.txt in the Rhea upload folders)
export const RHEA_DISCLAIMER = 'Education only; not accounting, tax or legal advice. Talk to your CPA.';
export const RHEA_MAX_HASHTAGS = 5;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** "Friday, November 6, 2026 at 9:05 AM" → { date: '2026-11-06', time: '09:05', weekday: 'friday' }, or null. */
export function parseScheduleLine(text) {
  const m = text.match(/^(\w+),\s+(\w+)\s+(\d{1,2}),\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase()) + 1;
  if (!month) return null;
  let hour = Number(m[5]) % 12;
  if (m[7].toUpperCase() === 'PM') hour += 12;
  const pad = (n) => String(n).padStart(2, '0');
  return { date: `${m[4]}-${pad(month)}-${pad(m[3])}`, time: `${pad(hour)}:${m[6]}`, weekday: m[1].toLowerCase() };
}

/** The weekday of a YYYY-MM-DD date, lowercased ("friday"). */
export const weekdayOf = (date) => WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];

/** Lines between a "==== NAME ..." header and the next "====" line. */
function section(lines, name) {
  const start = lines.findIndex((l) => l.startsWith(`==== ${name}`));
  if (start < 0) return null;
  const end = lines.findIndex((l, n) => n > start && l.startsWith('===='));
  return lines.slice(start + 1, end < 0 ? lines.length : end);
}

/**
 * Everything youtube-schedule.mjs needs from one upload.txt:
 * { schedule, videoFile, title, description, tags[], related, relatedNote, playlists[], pinnedComment, problems[] }.
 * related is the long's title for a Short, '' for a long or a Short without one.
 */
export function parseUpload(text, { rules = 'basics' } = {}) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const field = (name) => lines.find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1).trim() ?? '';
  const problems = [];

  const schedule = parseScheduleLine(field('SCHEDULE'));
  if (!schedule) problems.push('no SCHEDULE line in the expected form ("Friday, November 6, 2026 at 9:00 AM Pacific (PT)")');
  else if (!/Pacific|PT\b/.test(field('SCHEDULE'))) problems.push('the SCHEDULE time is not marked Pacific');
  else if (weekdayOf(schedule.date) !== schedule.weekday) problems.push(`SCHEDULE says ${schedule.weekday} but ${schedule.date} is a ${weekdayOf(schedule.date)}`);

  const title = (section(lines, 'TITLE') ?? []).map((l) => l.trim()).filter(Boolean).join(' ');
  const description = (section(lines, 'DESCRIPTION') ?? []).join('\n').trim();
  const tags = (section(lines, 'TAGS') ?? []).join(' ').split(',').map((t) => t.trim()).filter(Boolean);

  // "Related video: <title>  (note)" - the note after two spaces says when it can be set
  const rel = field('Related video');
  const none = /^none\b/i.test(rel);
  const [, related = '', relatedNote = ''] = none ? [] : rel.match(/^(.*?)(?:\s{2,}\((.*)\))?$/) ?? [];

  const playlists = field('Playlist suggestion').split(/\s+\+\s+/).map((p) => p.trim()).filter(Boolean);
  const pinned = section(lines, 'PINNED COMMENT');
  // "VIDEO FILE: youtube - Heart Failure Explained.mp4  (10:03, 1920x1080)"
  const videoFile = field('VIDEO FILE').split(/\s{2,}|\s+\(/)[0].trim();
  if (!videoFile) problems.push('no VIDEO FILE line');
  return {
    schedule, videoFile, title, description, tags, related: related.trim(), relatedNote: relatedNote.trim(), playlists,
    pinnedComment: pinned ? pinned.join('\n').trim() : '',
    problems: [...problems, ...checkYouTube({ title, description, tags }, { rules })],
  };
}

/** Length of the tags as YouTube counts it: commas between tags, and quotes around a tag with a space. */
export const tagsLength = (tags) => tags.reduce((n, t) => n + [...t].length + (/\s/.test(t) ? 2 : 0), 0) + Math.max(0, tags.length - 1);

/** Hashtags in a text ("#primecost"), as YouTube reads them. */
export const hashtags = (text) => [...text.matchAll(/(?:^|[^\p{L}\p{N}_&])#([\p{L}\p{N}_]+)/gu)].map((m) => `#${m[1]}`);

/**
 * Problems that would make YouTube reject the upload or break the channel's description rules; empty
 * when fine. rules 'basics' (default): every description links the three apps. rules 'rhea': no
 * "AI" word in the title, description or tags, at most five hashtags in the title and description,
 * the disclaimer line, no App Store or Google Play mention (and no app links required).
 */
export function checkYouTube({ title, description, tags = [] } = {}, { rules = 'basics' } = {}) {
  if (!['basics', 'rhea'].includes(rules)) throw new Error(`unknown description rules "${rules}"`);
  const problems = [];
  if (!title) problems.push('no title');
  if (!description) problems.push('no description');
  if (!title || !description) return problems;
  // videos resource: title ≤ 100 characters, description ≤ 5000 bytes, tags ≤ 500 characters,
  // and neither title nor description may contain < or >
  if ([...title].length > 100) problems.push(`title is ${[...title].length} characters (YouTube allows 100)`);
  if (Buffer.byteLength(description, 'utf8') > 5000) problems.push(`description is ${Buffer.byteLength(description, 'utf8')} bytes (YouTube allows 5000)`);
  if (/[<>]/.test(title + description)) problems.push('contains < or >, which YouTube rejects');
  if (tagsLength(tags) > 500) problems.push(`tags are ${tagsLength(tags)} characters as YouTube counts them (allows 500)`);
  if (rules === 'basics') {
    for (const [brand, id] of Object.entries(APP_IDS)) {
      if (!description.includes(id)) problems.push(`description does not link the ${brand} app (${id})`);
    }
  }
  if (rules === 'rhea') {
    // "AI", "A.I.", "A-I", "#ai" ... as a word, in any case; "artificial intelligence" too
    const ai = /(?:^|[^\p{L}\p{N}])(?:a\.?-?i\.?|artificial intelligence)(?![\p{L}\p{N}])/iu;
    for (const [where, text] of [['title', title], ['description', description], ['tags', tags.join(', ')]]) {
      if (ai.test(text)) problems.push(`the word "AI" is in the ${where} (Rhea rule: never)`);
    }
    const tagsUsed = hashtags(`${title}\n${description}`);
    if (tagsUsed.length > RHEA_MAX_HASHTAGS) problems.push(`${tagsUsed.length} hashtags in the title and description (Rhea rule: at most ${RHEA_MAX_HASHTAGS})`);
    if (!description.split('\n').some((l) => l.trim() === RHEA_DISCLAIMER)) problems.push(`the description lacks the line "${RHEA_DISCLAIMER}"`);
    if (/app store|google play|play store/i.test(`${title}\n${description}`)) problems.push('mentions the App Store or Google Play (Rhea rule: never)');
  }
  return problems;
}
