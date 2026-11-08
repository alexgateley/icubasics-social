// Adds the comment-to-get line ("💬 Comment SEPSIS and I'll DM you the free sepsis cheat sheet.") to the captions
// of scheduled posts that have not gone out yet, using comment-keywords.json (slug → keyword → page per brand).
// A brand without a page for that keyword gets no line. Turn this on only once scripts/comment-replies.mjs is
// answering on that account, or people comment and get nothing.
//
//   node scripts/add-keyword-cta.mjs                    # preview: list what would change (default: from tomorrow)
//   node scripts/add-keyword-cta.mjs --apply            # write the captions (then commit and push)
//   node scripts/add-keyword-cta.mjs --apply --from 2026-11-12 --brands icu,rn
//   node scripts/add-keyword-cta.mjs --remove --apply   # take the line out again
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(REPO, 'comment-keywords.json'), 'utf8'));
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const apply = args.includes('--apply');
const remove = args.includes('--remove');
const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const from = opt('--from') ?? tomorrow;
const brands = (opt('--brands') ?? 'icu,rn,medic').split(',');
const SLOTS = ['shorts', 'shorts-am', 'shorts-pm', 'features'];
const MARK = '💬 Comment ';

/** The keyword for a scheduled folder: its slug, or the slug without a re-post (rp-) or storybook (sb-) prefix. */
function keywordFor(folder) {
  for (const s of [folder, folder.replace(/^rp-/, ''), folder.replace(/^(rp-)?sb-/, '')]) if (config.slugs[s]) return config.slugs[s];
  return null;
}
const lineFor = (key) => `${MARK}${key} and I'll DM you the free ${config.keywords[key].label}.`;

/** Puts the line just above the "By Alex G" credit (or at the end), once. */
function withLine(caption, line) {
  const lines = caption.replace(/\n+$/, '').split('\n').filter((l) => !l.startsWith(MARK));
  if (!line) return lines.join('\n') + '\n';
  const at = lines.findIndex((l) => l.startsWith('By Alex G'));
  lines.splice(at >= 0 ? at : lines.length, 0, line);
  return lines.join('\n') + '\n';
}

let changed = 0;
const done = new Set();
for (const slot of SLOTS) {
  for (const brand of brands) {
    const schedulePath = path.join(REPO, slot, brand, 'schedule.json');
    if (!fs.existsSync(schedulePath)) continue;
    for (const [date, folder] of Object.entries(JSON.parse(fs.readFileSync(schedulePath, 'utf8')))) {
      if (date < from) continue;
      const file = path.join(REPO, slot, brand, folder, 'caption.txt');
      if (!fs.existsSync(file) || done.has(file)) continue;
      done.add(file);
      const key = keywordFor(folder);
      const line = remove ? null : key && config.keywords[key][brand] ? lineFor(key) : null;
      const before = fs.readFileSync(file, 'utf8');
      const after = withLine(before, line);
      if (after === before) continue;
      changed++;
      console.log(`${date} ${slot}/${brand}/${folder}: ${line ?? '(line removed)'}`);
      if (apply) fs.writeFileSync(file, after);
    }
  }
}
console.log(`${changed} caption${changed === 1 ? '' : 's'} ${apply ? 'changed' : 'would change (preview; add --apply to write)'}.`);
