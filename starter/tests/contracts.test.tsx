import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import App from '../src/App';
const start = () => render(<App />);
const controls = (name: RegExp | string) => [
  ...screen.queryAllByRole('button', { name }),
  ...screen.queryAllByRole('link', { name }),
];
const card = () => {
  const matches = controls(/^BB-001(?:$|[^A-Za-z0-9_-])/);
  expect(matches).toHaveLength(1);
  return matches[0];
};
const open = () => {
  fireEvent.click(card());
  return screen.getByRole('dialog', { name: 'Issue details' });
};
describe('BenchBoard basic product contracts', () => {
  it('renders project heading', () => {
    start();
    expect(
      screen.getByRole('heading', { level: 1 }).textContent?.trim(),
    ).toBeTruthy();
  });
  it('starts with 18 issue cards', () => {
    start();
    expect(controls(/^BB-\d{3}(?:$|[^A-Za-z0-9_-])/)).toHaveLength(18);
  });
  it('has three board columns', () => {
    start();
    for (const name of ['Backlog', 'In Progress', 'Done'])
      expect(screen.getByRole('region', { name })).toBeTruthy();
  });
  it('opens a labelled issue dialog', () => {
    start();
    expect(open()).toBeTruthy();
  });
  it('edits the title', () => {
    start();
    open();
    const el = screen.getByLabelText('Title');
    fireEvent.change(el, { target: { value: 'Updated issue' } });
    fireEvent.blur(el);
    expect(
      document.querySelector('[data-issue-id="BB-001"]')?.textContent,
    ).toContain('Updated issue');
  });
  it('edits the description', () => {
    start();
    open();
    const el = screen.getByLabelText('Description');
    fireEvent.change(el, { target: { value: 'Fresh description' } });
    fireEvent.blur(el);
    expect(
      JSON.parse(localStorage.getItem('benchboard')!).issues[0].description,
    ).toBe('Fresh description');
  });
  it('searches case insensitively', () => {
    start();
    fireEvent.change(screen.getByLabelText('Search issues'), {
      target: { value: 'KEYBOARD' },
    });
    expect(controls(/^BB-/)).toHaveLength(1);
  });
  it('supports one priority filter', () => {
    start();
    fireEvent.change(screen.getByLabelText('Filter priority'), {
      target: { value: 'Critical' },
    });
    expect(controls(/^BB-/)).toHaveLength(5);
  });
  it('clears search and filters', () => {
    start();
    fireEvent.change(screen.getByLabelText('Search issues'), {
      target: { value: 'KEYBOARD' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(controls(/^BB-/)).toHaveLength(18);
  });
  it('shows total and completed summary', () => {
    start();
    expect(screen.getByLabelText('Total issues').textContent).toBe('18');
    expect(screen.getByLabelText('Completed issues').textContent).toBe('4');
  });
  it('asks before deleting and permits cancel', () => {
    start();
    const dialog = open();
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Delete issue' }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(card()).toBeTruthy();
  });
  it('writes version one state', () => {
    start();
    expect(JSON.parse(localStorage.getItem('benchboard')!).version).toBe(1);
  });
  it('creates a new editable issue', () => {
    start();
    fireEvent.click(screen.getByRole('button', { name: 'Create issue' }));
    expect(controls(/^BB-/)).toHaveLength(19);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
  it('offers usable keyboard status movement', () => {
    start();
    expect(
      (screen.getByLabelText('Move BB-001') as HTMLSelectElement).disabled,
    ).toBe(false);
  });
  it('closes drawer with Escape', () => {
    start();
    open();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('migrates a v0 tasks collection', () => {
    localStorage.setItem(
      'benchboard',
      JSON.stringify({
        version: 0,
        tasks: [
          {
            id: 'OLD-1',
            title: 'Legacy issue',
            description: 'Preserve me',
            status: 'backlog',
            priority: 'Low',
            assignee: 'Maya Chen',
            labels: [],
            order: 0,
          },
        ],
        activity: [],
      }),
    );
    start();
    expect(
      document.querySelector('[data-issue-id="OLD-1"]')?.textContent,
    ).toContain('Legacy issue');
  });
  it('does not accept an empty title', () => {
    start();
    open();
    const el = screen.getByLabelText('Title');
    fireEvent.change(el, { target: { value: '  ' } });
    fireEvent.blur(el);
    expect(card()).toBeTruthy();
    expect(
      document.querySelector('[data-issue-id="BB-001"]')?.textContent,
    ).toContain('Fix keyboard navigation in project switcher');
  });
});
