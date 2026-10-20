// Export first; never stop a running local instance after a failed export.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.join(__dirname, '..');
const locator = path.join(os.tmpdir(), 'hub-demo-parchapp.json');

(async () => {
  const hub = JSON.parse(fs.readFileSync(locator, 'utf8'));
  if (!Number.isSafeInteger(hub.pid) || hub.pid <= 0) throw new Error('Invalid local emulator PID.');
  const origin = hub.origins.find(value => value.startsWith('http://127.0.0.1:'));
  if (!origin) throw new Error('Expected a loopback-only emulator hub.');
  const before = await (await fetch(`${origin}/`)).json();
  if (before.pid !== hub.pid) throw new Error('Emulator instance changed; not stopping it.');
  const cli = path.join(root, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js');
  const backup = spawnSync(process.execPath, [cli, 'emulators:export', './.emulator-data',
    '--project', 'demo-parchapp', '--force'], {cwd: root, stdio: 'inherit'});
  if (backup.status !== 0) throw new Error('Export failed. Backend was left running.');
  const after = await (await fetch(`${origin}/`)).json();
  if (after.pid !== hub.pid) throw new Error('Emulator instance changed after export; not stopping it.');
  if (process.platform === 'win32') {
    const stopped = spawnSync('taskkill.exe', ['/PID', String(hub.pid), '/T', '/F'], {stdio: 'inherit', windowsHide: true});
    if (stopped.status !== 0) throw new Error('Data saved, but process shutdown failed.');
  } else {
    process.kill(hub.pid, 'SIGINT');
  }
  console.log('Auth and Firestore saved. Local emulators stopped.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
