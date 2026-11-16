// Select a compatible local JDK without changing system Java/Android settings.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const root = path.join(__dirname, '..');
const homes = [process.env.PARCHAPP_JAVA_HOME, process.env.JAVA_HOME,
  path.join(os.homedir(), 'oracleJdk-27'),
  path.join(process.env.ProgramFiles || '/nonexistent', 'Android', 'Android Studio', 'jbr')];
for (const parent of [path.join(os.homedir(), '.jdks'),
  path.join(process.env.ProgramFiles || '/nonexistent', 'Eclipse Adoptium'),
  path.join(process.env.ProgramFiles || '/nonexistent', 'Java')]) {
  if (fs.existsSync(parent)) {
    homes.push(...fs.readdirSync(parent, {withFileTypes: true}).filter(d => d.isDirectory()).map(d => path.join(parent, d.name)));
  }
}
const executables = [...homes.filter(Boolean).map(h => path.join(h, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')), 'java'];
let runtime;
for (const executable of executables) {
  const result = spawnSync(executable, ['-version'], {encoding: 'utf8', windowsHide: true});
  const major = /version "(?:1\.)?(\d+)/.exec(`${result.stderr || ''}${result.stdout || ''}`)?.[1];
  if (result.status === 0 && Number(major) >= 21) { runtime = {executable, major}; break; }
}
if (!runtime) {
  console.error('Firebase emulators require Java 21+. Set PARCHAPP_JAVA_HOME to an installed JDK and retry.');
  process.exitCode = 1;
} else {
  const env = {...process.env};
  if (runtime.executable !== 'java') {
    env.JAVA_HOME = path.dirname(path.dirname(runtime.executable));
    env.PATH = `${path.dirname(runtime.executable)}${path.delimiter}${env.PATH || env.Path || ''}`;
    // Windows environment keys are case-insensitive; keep just one Path entry.
    delete env.Path;
  }
  console.log(`Emulator Java ${runtime.major}: ${runtime.executable}`);
  console.log('Data: .emulator-data (import on startup, export on Ctrl+C).');
  const cli = path.join(root, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js');
  const child = spawn(process.execPath, [cli, 'emulators:start', '--project', 'demo-parchapp',
    '--import=./.emulator-data', '--export-on-exit=./.emulator-data'], {cwd: root, env, stdio: 'inherit'});
  // The child shares the terminal and receives Ctrl+C; let Firebase finish export.
  process.on('SIGINT', () => {});
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
