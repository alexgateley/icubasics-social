// The YouTube Shorts title and description for a topic, shared by add-short.mjs (which writes them to
// shorts*/rn/<slug>/youtube.json) and youtube.mjs (which uploads with them). They come from the
// "YOUTUBE SHORTS" part of "short - captions and tags.txt" (in the RN BASICS section in newer files,
// under ICU BASICS in the October ones; either way it is the RN video that goes up):
//
//   YOUTUBE SHORTS  (TheRNBasics channel, upload short - RN Basics.mp4)
//   Title (≤100):  <title>
//   Description:
//   <every line through the hashtag line (or up to the next ════ line or the end of the file)>

// Every description links all three apps (Alex, 2026-10-28); these are the App Store ids in the block
export const APP_IDS = { icu: 'id6809866200', rn: 'id6817038868', medic: 'id6817189556' };

/** { title, description } from a captions file, or null when it has no YouTube part. */
export function parseYouTube(text) {
  const all = text.split('\n');
  const start = all.findIndex((l) => l.startsWith('YOUTUBE SHORTS'));
  if (start < 0) return null;
  const end = all.findIndex((l, n) => n > start && /^═{3,}/.test(l));
  const lines = all.slice(0, end < 0 ? all.length : end);
  const titleLine = lines.slice(start + 1).find((l) => l.startsWith('Title'));
  const descAt = lines.findIndex((l, n) => n > start && l.startsWith('Description:'));
  if (!titleLine || descAt < 0) return null;
  const title = titleLine.replace(/^Title[^:]*:\s*/, '').trim();
  // The description ends with its hashtag line; anything after it is a note for Alex (e.g. "Tip: ...")
  const body = lines.slice(descAt + 1);
  const tags = body.findIndex((l) => /^#\w/.test(l));
  const description = (tags < 0 ? body : body.slice(0, tags + 1)).join('\n').trim();
  return { title, description };
}

/** Problems that would make YouTube reject the upload or break Alex's description rules; empty when fine. */
export function checkYouTube({ title, description } = {}) {
  const problems = [];
  if (!title) problems.push('no title');
  if (!description) problems.push('no description');
  if (!title || !description) return problems;
  // videos resource: title ≤ 100 characters, description ≤ 5000 bytes, neither may contain < or >
  if ([...title].length > 100) problems.push(`title is ${[...title].length} characters (YouTube allows 100)`);
  if (Buffer.byteLength(description, 'utf8') > 5000) problems.push(`description is ${Buffer.byteLength(description, 'utf8')} bytes (YouTube allows 5000)`);
  if (/[<>]/.test(title + description)) problems.push('contains < or >, which YouTube rejects');
  for (const [brand, id] of Object.entries(APP_IDS)) {
    if (!description.includes(id)) problems.push(`description does not link the ${brand} app (${id})`);
  }
  return problems;
}
