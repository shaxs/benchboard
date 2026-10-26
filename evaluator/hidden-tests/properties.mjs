import { expect as baseExpect } from '@playwright/test';
const expect = baseExpect.configure({ timeout: 1800 });
import fs from 'node:fs';
const fixture = JSON.parse(
  fs.readFileSync(new URL('../../fixtures/v1.json', import.meta.url)),
);
const legacy = JSON.parse(
  fs.readFileSync(new URL('../../fixtures/v0.json', import.meta.url)),
);
const card = (p, id = 'BB-001') =>
  p
    .getByRole('button', {
      name: new RegExp('^' + id + '(?=$|[^A-Za-z0-9_-])'),
    })
    .or(
      p.getByRole('link', {
        name: new RegExp('^' + id + '(?=$|[^A-Za-z0-9_-])'),
      }),
    );
const cards = (p, status) =>
  p
    .getByRole('region', { name: status, exact: true })
    .locator('[data-issue-id]');
const output = (p, name) => p.getByLabel(name, { exact: true });
const open = async (p, id = 'BB-001') => {
  await card(p, id).click();
  await expect(p.getByRole('dialog')).toBeVisible();
};
const edit = async (p, name, value) => {
  await p.getByLabel(name, { exact: true }).fill(value);
  await p.getByLabel(name, { exact: true }).press('Tab');
};
const state = (p) =>
  p.evaluate(() => JSON.parse(localStorage.getItem('benchboard')));
const ids = async (p, status) =>
  (await cards(p, status).all()).map(
    async (c) => await c.getAttribute('data-issue-id'),
  );
const order = async (p, status) => Promise.all(await ids(p, status));
const load = async (p, data) => {
  await p.evaluate(
    (d) => localStorage.setItem('benchboard', JSON.stringify(d)),
    data,
  );
  await p.reload();
};
async function drag(p, id, status, before) {
  await p.setViewportSize({ width: 1440, height: 2400 });
  const source = p.locator('[data-issue-id="' + id + '"]');
  const target = before
    ? p.locator('[data-issue-id="' + before + '"]')
    : p.getByRole('region', { name: status, exact: true });
  await source.dragTo(target, {
    sourcePosition: { x: 5, y: 5 },
    targetPosition: { x: 5, y: 5 },
  });
}
const percentage = async (p) =>
  Number.parseFloat(await output(p, 'Completion percentage').textContent());
const revealAnalytics = async (p, name) => {
  const metric = output(p, name);
  if (await metric.isVisible()) return;
  const disclosure = p
    .getByRole('button', { name: /analytics|workload|breakdown/i })
    .or(
      p.locator('summary').filter({ hasText: /analytics|workload|breakdown/i }),
    );
  await disclosure.first().click();
};
export const properties = [
  [
    'F01',
    'functional',
    'Canonical fixture and all status totals',
    async (p) => {
      expect(await order(p, 'Backlog')).toHaveLength(8);
      expect(await order(p, 'In Progress')).toHaveLength(6);
      expect(await order(p, 'Done')).toHaveLength(4);
      expect(await percentage(p)).toBe(22);
    },
  ],
  [
    'F02',
    'functional',
    'Cross-column drag synchronizes status, totals and one event',
    async (p) => {
      const old = await state(p);
      await drag(p, 'BB-001', 'Done');
      expect(await order(p, 'Done')).toContain('BB-001');
      await expect(output(p, 'Completed issues')).toHaveText('5');
      const next = await state(p);
      expect(next.issues.find((i) => i.id === 'BB-001').status).toBe('done');
      expect(next.activity.length - old.activity.length).toBe(1);
    },
  ],
  [
    'F03',
    'functional',
    'Within-column insertion preserves all other relative order',
    async (p) => {
      await drag(p, 'BB-008', 'Backlog', 'BB-002');
      expect(await order(p, 'Backlog')).toEqual([
        'BB-001',
        'BB-008',
        'BB-002',
        'BB-003',
        'BB-004',
        'BB-005',
        'BB-006',
        'BB-007',
      ]);
    },
  ],
  [
    'F04',
    'functional',
    'Deletion immediately updates total, completed and percentage',
    async (p) => {
      await open(p, 'BB-015');
      await p
        .getByRole('button', { name: 'Delete issue', exact: true })
        .click();
      await p.getByRole('button', { name: 'Confirm delete' }).click();
      await expect(output(p, 'Total issues')).toHaveText('17');
      await expect(output(p, 'Completed issues')).toHaveText('3');
      expect(await percentage(p)).toBe(18);
      await expect(p.getByRole('dialog')).toHaveCount(0);
    },
  ],
  [
    'F05',
    'functional',
    'Filters intersect across two and four dimensions',
    async (p) => {
      await p.getByLabel('Filter priority').selectOption('Critical');
      await p.getByLabel('Filter status').selectOption('done');
      expect(await order(p, 'Done')).toEqual(['BB-017']);
      expect(await order(p, 'Backlog')).toEqual([]);
      await p.getByLabel('Filter assignee').selectOption('Maya Chen');
      await p.getByLabel('Filter label').selectOption('frontend');
      expect(await p.locator('[data-issue-id]').count()).toBe(1);
      await p.getByLabel('Filter assignee').selectOption('Sam Patel');
      expect(await p.locator('[data-issue-id]').count()).toBe(0);
      await p.getByLabel('Filter assignee').selectOption('Maya Chen');
      await p.getByLabel('Filter label').selectOption('performance');
      expect(await p.locator('[data-issue-id]').count()).toBe(0);
    },
  ],
  [
    'F06',
    'functional',
    'Search intersects filters and covers description, assignee and labels',
    async (p) => {
      await p.getByLabel('Filter status').selectOption('done');
      await p.getByLabel('Search issues').fill('KEYBOARD');
      expect(await p.locator('[data-issue-id]').count()).toBe(0);
      await p.getByRole('button', { name: 'Clear filters' }).click();
      for (const q of [
        'realistic project data',
        'MAYA CHEN',
        'accessibility',
      ]) {
        await p.getByLabel('Search issues').fill(q);
        expect(await p.locator('[data-issue-id]').count()).toBeGreaterThan(0);
      }
    },
  ],
  [
    'F07',
    'functional',
    'Drawer status appends and preserves destination order',
    async (p) => {
      const before = await order(p, 'Done');
      await open(p);
      await p.getByLabel('Status', { exact: true }).selectOption('done');
      await p.getByRole('button', { name: 'Close', exact: true }).click();
      expect(await order(p, 'Done')).toEqual([...before, 'BB-001']);
      expect(await order(p, 'Backlog')).toEqual([
        'BB-002',
        'BB-003',
        'BB-004',
        'BB-005',
        'BB-006',
        'BB-007',
        'BB-008',
      ]);
    },
  ],
  [
    'F08',
    'functional',
    'Labels trim, normalize case, deduplicate and accept new labels',
    async (p) => {
      await open(p);
      await edit(p, 'Labels', ' Frontend, frontend, , PERFORMANCE, Custom ');
      expect(
        (await state(p)).issues.find((i) => i.id === 'BB-001').labels,
      ).toEqual(['frontend', 'performance', 'custom']);
    },
  ],
  [
    'F09',
    'functional',
    'One priority action records exactly one activity event',
    async (p) => {
      await open(p);
      const n = (await state(p)).activity.length;
      await p.getByLabel('Priority', { exact: true }).selectOption('Low');
      expect((await state(p)).activity.length - n).toBe(1);
    },
  ],
  [
    'F10',
    'functional',
    'Activity chronology uses raw dates across month/year boundaries',
    async (p) => {
      const d = structuredClone(fixture);
      d.activity = [
        {
          id: 'a',
          issueId: 'BB-001',
          timestamp: '2024-12-31T23:59:59Z',
          message: 'Old year',
        },
        {
          id: 'b',
          issueId: 'BB-001',
          timestamp: '2025-02-01T00:00:00Z',
          message: 'Newest month',
        },
        {
          id: 'c',
          issueId: 'BB-001',
          timestamp: '2025-01-15T12:00:00Z',
          message: 'Middle month',
        },
      ];
      await load(p, d);
      await open(p);
      const times = await p
        .getByLabel('Activity', { exact: true })
        .locator('time')
        .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('datetime')));
      expect(times.map((t) => Date.parse(t))).toEqual([
        Date.parse('2025-02-01T00:00:00Z'),
        Date.parse('2025-01-15T12:00:00Z'),
        Date.parse('2024-12-31T23:59:59Z'),
      ]);
      for (const message of ['Newest month', 'Middle month', 'Old year'])
        await expect(p.getByLabel('Activity', { exact: true })).toContainText(
          message,
        );
    },
  ],
  [
    'F11',
    'functional',
    'All fields commit and affect card, search and workload',
    async (p) => {
      await open(p);
      await edit(p, 'Title', 'New engineering title');
      await edit(p, 'Description', 'Unique needle phrase');
      await p.getByLabel('Assignee', { exact: true }).selectOption('');
      await p.getByLabel('Priority', { exact: true }).selectOption('Low');
      await edit(p, 'Labels', 'custom');
      await p.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(p.locator('[data-issue-id="BB-001"]')).toContainText(
        'New engineering title',
      );
      await expect(p.locator('[data-issue-id="BB-001"]')).toContainText(
        'Unassigned',
      );
      await p.getByLabel('Search issues').fill('needle');
      expect(await p.locator('[data-issue-id]').count()).toBe(1);
      await revealAnalytics(p, 'Count Unassigned');
      await expect(output(p, 'Count Unassigned')).toHaveText('1');
    },
  ],
  [
    'F12',
    'functional',
    'Creation yields unique editable IDs and one event per issue',
    async (p) => {
      const n = (await state(p)).activity.length;
      await p.getByRole('button', { name: 'Create issue' }).click();
      await expect(p.getByRole('dialog')).toBeVisible();
      await edit(p, 'Title', 'Created by user');
      await p.getByRole('button', { name: 'Close', exact: true }).click();
      await p.getByRole('button', { name: 'Create issue' }).click();
      const s = await state(p);
      expect(s.issues.length).toBe(20);
      expect(new Set(s.issues.map((i) => i.id)).size).toBe(20);
      expect(s.activity.length - n).toBe(3);
      await expect(output(p, 'Total issues')).toHaveText('20');
    },
  ],
  [
    'F13',
    'functional',
    'Keyboard alternative moves and Escape restores focus',
    async (p) => {
      await p.getByLabel('Move BB-001', { exact: true }).selectOption('done');
      expect(await order(p, 'Done')).toContain('BB-001');
      await card(p).focus();
      await card(p).press('Enter');
      await p.keyboard.press('Escape');
      await expect(p.getByRole('dialog')).toHaveCount(0);
      await expect(card(p)).toBeFocused();
    },
  ],
  [
    'P01',
    'persistence',
    'Drag insertion survives reload exactly',
    async (p) => {
      await drag(p, 'BB-008', 'Backlog', 'BB-002');
      const live = await order(p, 'Backlog');
      await p.reload();
      expect(await order(p, 'Backlog')).toEqual(live);
      await drag(p, 'BB-001', 'Done', 'BB-016');
      const done = await order(p, 'Done');
      await p.reload();
      expect(await order(p, 'Done')).toEqual(done);
    },
  ],
  [
    'P02',
    'persistence',
    'Edits and activity persist through reload',
    async (p) => {
      await open(p);
      await edit(p, 'Title', 'Persisted title');
      await edit(p, 'Labels', 'shipping');
      await p.getByLabel('Priority', { exact: true }).selectOption('Low');
      const s = await state(p);
      await p.reload();
      expect(await state(p)).toEqual(s);
      await open(p);
      await expect(p.getByLabel('Title', { exact: true })).toHaveValue(
        'Persisted title',
      );
    },
  ],
  [
    'P03',
    'persistence',
    'Legacy migration preserves IDs, data, ordering and activity idempotently',
    async (p) => {
      const d = structuredClone(legacy);
      d.tasks = d.tasks.slice(0, 3);
      d.tasks[0].title = 'Legacy customized';
      d.tasks[0].order = 2;
      d.tasks[2].order = 0;
      await load(p, d);
      const s = await state(p);
      expect(s.version).toBe(1);
      expect(s.issues).toEqual(d.tasks);
      expect(s.activity).toEqual(d.activity);
      await p.reload();
      expect(await state(p)).toEqual(s);
    },
  ],
  [
    'P04',
    'persistence',
    'Loaded custom state is retained without reseeding',
    async (p) => {
      const d = structuredClone(fixture);
      d.issues = d.issues.slice(0, 2);
      d.issues[0].title = 'Custom persisted';
      await load(p, d);
      expect((await state(p)).issues).toEqual(d.issues);
      await expect(output(p, 'Total issues')).toHaveText('2');
      await p.reload();
      expect((await state(p)).issues).toEqual(d.issues);
    },
  ],
  [
    'E01',
    'edge',
    'Invalid JSON and malformed shapes recover safely',
    async (p) => {
      for (const text of [
        '{broken',
        'null',
        '{"version":1,"issues":{},"activity":[]}',
        '{"version":1,"issues":[{}],"activity":[]}',
      ]) {
        await p.evaluate((t) => localStorage.setItem('benchboard', t), text);
        await p.reload();
        await expect(output(p, 'Total issues')).toHaveText('18');
      }
    },
  ],
  [
    'E02',
    'edge',
    'Empty board remains empty with zero completion across reload',
    async (p) => {
      await load(p, { version: 1, issues: [], activity: [] });
      await expect(output(p, 'Total issues')).toHaveText('0');
      expect(await percentage(p)).toBe(0);
      expect(await p.locator('[data-issue-id]').count()).toBe(0);
      await p.reload();
      await expect(output(p, 'Total issues')).toHaveText('0');
    },
  ],
  [
    'E03',
    'edge',
    'Editing a filtered-out issue remains safe and deletion closes drawer',
    async (p) => {
      await p.getByLabel('Filter priority').selectOption('Critical');
      await open(p);
      await p.getByLabel('Priority', { exact: true }).selectOption('Low');
      await expect(p.getByRole('dialog')).toBeVisible();
      await edit(p, 'Title', 'Still editable');
      await p
        .getByRole('button', { name: 'Delete issue', exact: true })
        .click();
      await p.getByRole('button', { name: 'Confirm delete' }).click();
      await expect(p.getByRole('dialog')).toHaveCount(0);
      await p.getByRole('button', { name: 'Clear filters' }).click();
      await expect(card(p)).toHaveCount(0);
      await expect(output(p, 'Total issues')).toHaveText('17');
    },
  ],
  [
    'E04',
    'edge',
    'No-op edits and self-drops create no activity and empty title is rejected',
    async (p) => {
      await open(p);
      const before = (await state(p)).activity.length;
      await edit(p, 'Title', 'Fix keyboard navigation in project switcher');
      await edit(p, 'Labels', 'frontend, accessibility');
      await edit(p, 'Title', '   ');
      await p.getByRole('button', { name: 'Close', exact: true }).click();
      await drag(p, 'BB-001', 'Backlog', 'BB-001');
      expect((await state(p)).activity.length).toBe(before);
      await expect(p.locator('[data-issue-id="BB-001"]')).toContainText(
        'Fix keyboard navigation',
      );
    },
  ],
  [
    'I01',
    'integration',
    'Responsive board and drawer have no overflow or browser errors',
    async (p, ctx) => {
      for (const width of [1440, 1024, 768]) {
        await p.setViewportSize({ width, height: 1000 });
        await p.reload();
        expect(
          await p.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await p.screenshot({
          path: ctx.artifact('board-' + width + '.png'),
          fullPage: true,
        });
        await open(p);
        expect(
          await p.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await p.screenshot({
          path: ctx.artifact('drawer-' + width + '.png'),
          fullPage: true,
        });
        await p.getByRole('button', { name: 'Close', exact: true }).click();
      }
      expect(ctx.errors).toEqual([]);
    },
  ],
  [
    'I02',
    'integration',
    'Drawer traps Tab and shift-Tab until dismissed',
    async (p) => {
      await open(p);
      const focusable = await p
        .getByRole('dialog')
        .locator('button,a[href],input,textarea,select,[tabindex]')
        .count();
      for (const key of ['Tab', 'Shift+Tab'])
        for (let n = 0; n < focusable + 2; n++) {
          await p.keyboard.press(key);
          expect(
            await p
              .getByRole('dialog')
              .evaluate((el) => el.contains(document.activeElement)),
          ).toBe(true);
        }
      await p.keyboard.press('Escape');
      await expect(p.getByRole('dialog')).toHaveCount(0);
    },
  ],
  [
    'I03',
    'integration',
    'Storage write failure gives feedback and keeps app usable',
    async (p) => {
      await p.evaluate(() => {
        Storage.prototype.setItem = function () {
          throw new DOMException('Full', 'QuotaExceededError');
        };
      });
      await open(p);
      await edit(p, 'Title', 'Quota-safe update');
      await p.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(p.locator('[data-issue-id="BB-001"]')).toContainText(
        'Quota-safe update',
      );
      await expect(
        p
          .getByRole('status')
          .filter({
            hasText: /fail|could|unable|error|quota|not.*sav|not.*persist/i,
          })
          .first(),
      ).toBeVisible();
    },
  ],
  [
    'I04',
    'integration',
    'Whole workflow integrates editing, movement, deletion, reload and summaries',
    async (p) => {
      await open(p);
      await edit(p, 'Title', 'Integrated flow');
      await p.getByLabel('Status', { exact: true }).selectOption('done');
      await p.getByRole('button', { name: 'Close', exact: true }).click();
      await p.reload();
      await expect(p.locator('[data-issue-id="BB-001"]')).toContainText(
        'Integrated flow',
      );
      await expect(output(p, 'Completed issues')).toHaveText('5');
      await open(p);
      await p
        .getByRole('button', { name: 'Delete issue', exact: true })
        .click();
      await p.getByRole('button', { name: 'Confirm delete' }).click();
      await p.reload();
      await expect(output(p, 'Total issues')).toHaveText('17');
      await expect(output(p, 'Completed issues')).toHaveText('4');
    },
  ],
];
export const defectWitnesses = {
  persistedOrder: 'P01',
  deleteAnalytics: 'F04',
  filterUnion: 'F05',
  drawerOrder: 'F07',
  labelCase: 'F08',
  duplicateActivity: 'F09',
  formattedChronology: 'F10',
};
