// Sets up this Mac to do the daily steps by itself, using macOS's own scheduler (launchd):
//
//   9:00 AM on weekdays  opens the live mode (Start live mode.command), which stops at 4 PM.
//   9:00 PM on weekdays  starts GitHub's "Update the site", because GitHub's own schedule runs hours late.
//
// If the Mac is asleep at those times, macOS runs them when it wakes.
//
//   npm run automate               turn both on
//   npm run automate -- --remove   turn both off
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const AGENTS = join(homedir(), 'Library', 'LaunchAgents');
const LOGS = join(homedir(), 'Library', 'Logs');
const REPO = 'mpipos/mpipos.github.io';
const WEEKDAYS = [1, 2, 3, 4, 5];
const domain = `gui/${userInfo().uid}`;

const escapeXml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plist({ label, program, hour, minute, workingDirectory, log }) {
  const times = WEEKDAYS.map((day) => `    <dict><key>Weekday</key><integer>${day}</integer><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${program.map((part) => `    <string>${escapeXml(part)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(workingDirectory)}</string>
  <key>StartCalendarInterval</key>
  <array>
${times}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>StandardOutPath</key><string>${escapeXml(log)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(log)}</string>
</dict>
</plist>
`;
}

function findGh() {
  for (const candidate of ['/opt/homebrew/bin/gh', '/usr/local/bin/gh']) if (existsSync(candidate)) return candidate;
  try {
    return execFileSync('/usr/bin/which', ['gh'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

const gh = findGh();
const jobs = [
  {
    label: 'com.mpipos.live',
    what: 'Opens the live mode at 9:00 AM on weekdays',
    // Opened in Terminal, which already has access to this folder, rather than run unseen in the background.
    program: ['/usr/bin/open', '-a', 'Terminal', join(ROOT, 'Start live mode.command')],
    hour: 9,
    minute: 0,
    workingDirectory: homedir(),
    log: join(LOGS, 'mpipos-live.log'),
  },
  gh && {
    label: 'com.mpipos.update',
    what: 'Starts the site update at 9:00 PM on weekdays',
    program: [gh, 'workflow', 'run', 'update.yml', '--ref', 'main', '-R', REPO],
    hour: 21,
    minute: 0,
    workingDirectory: homedir(),
    log: join(LOGS, 'mpipos-update.log'),
  },
].filter(Boolean);

const stop = (label) => {
  try {
    execFileSync('/bin/launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
  } catch {
    // Not loaded, which is fine.
  }
};

if (process.argv.includes('--remove')) {
  for (const { label } of [{ label: 'com.mpipos.live' }, { label: 'com.mpipos.update' }]) {
    stop(label);
    rmSync(join(AGENTS, `${label}.plist`), { force: true });
  }
  console.log('Turned off: the 9 AM live mode and the 9 PM site update. Everything else is unchanged.');
  process.exit(0);
}

mkdirSync(AGENTS, { recursive: true });
mkdirSync(LOGS, { recursive: true });
for (const job of jobs) {
  const file = join(AGENTS, `${job.label}.plist`);
  writeFileSync(file, plist(job));
  stop(job.label);
  execFileSync('/bin/launchctl', ['bootstrap', domain, file]);
  console.log(`On: ${job.what}.`);
}
if (!gh) console.log('The 9 PM site update needs the GitHub CLI (gh), which isn’t installed, so only the live mode is set up.');
console.log(`Logs: ${LOGS}/mpipos-*.log. To turn this off: npm run automate -- --remove`);
