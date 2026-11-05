// Reads and writes the posting credentials in Alex's macOS login keychain (service "icubasics-social"),
// for the scripts that run on the Mac instead of GitHub Actions (youtube-auth.mjs, youtube-schedule.mjs,
// analytics.mjs).
// Values go to `security` on stdin, never on the command line where `ps` could see them, and are
// never logged. Store them with scripts/setup-keychain.sh.
import { execFileSync } from 'node:child_process';

// KEYCHAIN_SERVICE exists only so tests can use throwaway items
export const SERVICE = process.env.KEYCHAIN_SERVICE || 'icubasics-social';

/** The stored value, or '' when there is none. */
export function readSecret(account) {
  try {
    return execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** Adds or replaces a value (security -i reads the command from stdin). */
export function writeSecret(account, value) {
  if (!/^[\x21-\x7e]+$/.test(value)) throw new Error(`refusing to store ${account}: the value has spaces or unusual characters`);
  const quote = (s) => `"${s.replace(/(["\\])/g, '\\$1')}"`;
  execFileSync('security', ['-i'], {
    input: `add-generic-password -U -s ${quote(SERVICE)} -a ${quote(account)} -w ${quote(value)}\n`,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  if (readSecret(account) !== value) throw new Error(`the keychain did not keep ${account}`);
}
