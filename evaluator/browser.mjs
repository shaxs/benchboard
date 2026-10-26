import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { properties } from './hidden-tests/properties.mjs';
export async function browserEvaluate(url, destination, only = null) {
  fs.mkdirSync(destination, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    for (const [id, area, name, run] of properties) {
      if (only && !only.includes(id)) continue;
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        timezoneId: 'UTC',
        locale: 'en-US',
      });
      const page = await context.newPage();
      page.setDefaultTimeout(3500);
      page.setDefaultNavigationTimeout(15000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      // Block outbound requests, even if participant JavaScript attempts them.
      await context.route('**/*', (route) => {
        const u = new URL(route.request().url());
        u.origin === new URL(url).origin ? route.continue() : route.abort();
      });
      let phase = 'STARTUP';
      try {
        await page.goto(url);
        await page.getByLabel('Total issues', { exact: true }).waitFor();
        phase = 'PROPERTY';
        await run(page, {
          errors,
          artifact: (name) => path.join(destination, name),
        });
        results.push({ id, area, name, passed: true });
      } catch (error) {
        results.push({
          id,
          area,
          name,
          passed: false,
          phase,
          browserErrors: errors,
          error: String(error).slice(0, 4000),
        });
        await page
          .screenshot({
            path: path.join(destination, id + '-failure.png'),
            fullPage: true,
          })
          .catch(() => {});
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(
    path.join(destination, 'hidden.json'),
    JSON.stringify(results, null, 2),
  );
  return results;
}
