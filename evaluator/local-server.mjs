import { spawn } from 'node:child_process';
import path from 'node:path';
import net from 'node:net';
export async function localServer(app) {
  const port = await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const child = spawn(
    process.execPath,
    [
      path.resolve(app, 'node_modules/vite/bin/vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    { cwd: app, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  let logs = '';
  child.stdout.on('data', (d) => (logs += d));
  child.stderr.on('data', (d) => (logs += d));
  const url = 'http://127.0.0.1:' + port;
  for (let n = 0; n < 100; n++) {
    try {
      if ((await fetch(url)).ok)
        return { url, close: () => child.kill(), logs: () => logs };
    } catch {}
    if (child.exitCode !== null) throw Error(logs);
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw Error('Local server timed out: ' + logs);
}
