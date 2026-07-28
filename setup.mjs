// One-time setup, run once by whoever hosts Festifind: `npm run setup`.
//
// The point of this file is that nobody else ever has to do it. Once a Client ID
// is stored, every other person just clicks "Continue with Spotify".

import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { stdin, stdout } from 'node:process';

const CONFIG = fileURLToPath(new URL('./src/config.js', import.meta.url));
const PORT = Number(process.env.PORT) || 8888;
// The redirect target is the app's own base URL, not a /callback route — that is
// what lets it run unchanged on a static host with no server-side routing.
const REDIRECT = `http://127.0.0.1:${PORT}/`;

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

// Non-interactive path: `npm run setup -- <clientId> [name]`. Also what makes
// this script testable, since a closed stdin can never answer a prompt.
const [argClientId, ...argOwner] = process.argv.slice(2);
const interactive = !argClientId && stdin.isTTY;

if (!argClientId && !stdin.isTTY) {
  console.log(
    `\nNo terminal available to prompt on.\n` +
    `Pass the values directly instead:\n\n` +
    `  ${bold('npm run setup -- <clientId> [your name]')}\n`
  );
  process.exit(1);
}

const rl = interactive ? createInterface({ input: stdin, output: stdout }) : null;

/** Never leaves a dangling promise if stdin closes mid-prompt. */
async function ask(question, fallback = '') {
  if (!rl) return fallback;
  const answer = await Promise.race([
    rl.question(question),
    new Promise((resolve) => rl.once('close', () => resolve(null))),
  ]);
  return answer === null ? fallback : answer;
}

if (interactive) console.log(`
${bold('Festifind setup')}
${dim('Runs once. After this, anyone you invite just clicks a button.')}

${bold('1.')} Open ${green('https://developer.spotify.com/dashboard')} and click ${bold('Create app')}.
   Name and description can be anything.

${bold('2.')} Under ${bold('Redirect URIs')}, add this exactly — including the trailing slash:

      ${green(REDIRECT)}

   ${dim(`Use 127.0.0.1, not "localhost" — Spotify rejects the localhost form.`)}

   ${dim('Hosting it on GitHub Pages too? Add that URL as a second redirect URI,')}
   ${dim('with its trailing slash, e.g.:')}
      ${dim('https://YOURNAME.github.io/festifind/')}

${bold('3.')} Tick ${bold('Web API')}, save, then copy the ${bold('Client ID')}.
`);

const clientId = (argClientId || (await ask(`${bold('Paste the Client ID:')} `))).trim();

if (!/^[0-9a-f]{32}$/i.test(clientId)) {
  console.log(
    `\n${yellow('That does not look like a Spotify Client ID.')} It should be 32 letters and digits.\n` +
    `Nothing was saved — run ${bold('npm run setup')} again.\n`
  );
  rl?.close();
  process.exit(1);
}

const owner = (
  argOwner.join(' ') ||
  (await ask(
    `${bold('Your name or email')} ${dim('(optional, shown to people not yet on the allowlist):')} `
  ))
).trim();

rl?.close();

// Preserve the explanatory header; only swap the two values.
const current = await readFile(CONFIG, 'utf8');
const updated = current
  .replace(/export const SPOTIFY_CLIENT_ID = .*;/, `export const SPOTIFY_CLIENT_ID = '${clientId}';`)
  .replace(/export const OWNER_CONTACT = .*;/, `export const OWNER_CONTACT = '${owner.replace(/'/g, "\\'")}';`);

await writeFile(CONFIG, updated);

console.log(`
${green('Saved.')} Start it with ${bold('npm start')} and open ${green(`http://127.0.0.1:${PORT}`)}

${bold('Before inviting anyone, two things Spotify requires:')}

  ${yellow('•')} ${bold('You need Spotify Premium.')} Since March 2026 apps in Development Mode
    only work if the app owner has an active Premium subscription.

  ${yellow('•')} ${bold('Add each person to the allowlist.')} In the dashboard, open your app →
    Settings → ${bold('User Management')} → add their Spotify account email.
    ${bold('The cap is 5 people, including you.')} Anyone not on the list gets an
    error when they try to sign in.

  ${dim('Lifting the 5-user cap needs Spotify Extended Quota, which requires a')}
  ${dim('registered business with 250,000+ monthly active users. Not realistic')}
  ${dim('for a personal project — treat 5 as the ceiling.')}
`);
