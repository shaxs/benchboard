import path from 'node:path';
import { root } from '../runner/files.mjs';
import { localServer } from './local-server.mjs';
import { browserEvaluate } from './browser.mjs';
const app = path.resolve(process.argv[2] || 'reference');
if (
  ![path.join(root, 'reference'), path.join(root, 'starter')].includes(app) &&
  process.env.BENCHBOARD_OWNER_TRUSTED_FIXTURE !== '1'
)
  throw Error(
    'Use runner/evaluate.mjs for registered cooperative submissions after participants stop.',
  );
const server = await localServer(app);
try {
  const results = await browserEvaluate(
    server.url,
    path.resolve('artifacts', path.basename(app) + '-browser'),
  );
  console.log(
    JSON.stringify(
      {
        passed: results.filter((r) => r.passed).length,
        total: results.length,
        failures: results.filter((r) => !r.passed),
      },
      null,
      2,
    ),
  );
} finally {
  server.close();
}
