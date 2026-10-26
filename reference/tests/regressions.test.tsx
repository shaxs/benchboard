import { it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import App from '../src/App';
import { Model, newest } from '../src/model';
it('persists identities and complete data', () => {
  const m = new Model();
  expect(JSON.parse(localStorage.getItem('benchboard')!).issues).toEqual(
    m.state.issues,
  );
});
it('commits entered description through interaction', () => {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /^BB-001 / }));
  const input = screen.getByLabelText('Description');
  fireEvent.change(input, { target: { value: 'Fresh entered details' } });
  fireEvent.blur(input);
  expect(
    JSON.parse(localStorage.getItem('benchboard')!).issues[0].description,
  ).toBe('Fresh entered details');
});
it('commits selected priority through rendered interaction', () => {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /^BB-001 / }));
  fireEvent.change(screen.getByLabelText('Priority'), {
    target: { value: 'Low' },
  });
  expect(
    screen.getByRole('button', { name: /^BB-001 / }).textContent,
  ).toContain('Low');
});
it('moves keyboard focus into and restores from the drawer', () => {
  render(<App />);
  const card = screen.getByRole('button', { name: /^BB-001 / });
  card.focus();
  fireEvent.click(card);
  expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(
    true,
  );
});
it('normalizes labels case insensitively', () => {
  const m = new Model();
  m.patch('BB-001', { labels: [' Shipping ', 'shipping', 'Frontend'] });
  expect(m.state.issues[0].labels).toEqual(['shipping', 'frontend']);
});
it('orders activity by raw time across years', () => {
  expect(
    newest([
      {
        id: 'a',
        issueId: 'BB-001',
        timestamp: '2024-12-31T23:59:59Z',
        message: 'older',
      },
      {
        id: 'b',
        issueId: 'BB-001',
        timestamp: '2025-02-01T00:00:00Z',
        message: 'newer',
      },
    ]).map((x) => x.id),
  ).toEqual(['b', 'a']);
});
it('persists movement without losing relative order', () => {
  const m = new Model();
  m.move('BB-008', 'backlog', 'BB-002');
  expect(JSON.parse(localStorage.getItem('benchboard')!).issues).toEqual(
    m.state.issues,
  );
});
it('deletion updates analytics including empty completion', () => {
  const m = new Model();
  for (const i of [...m.state.issues]) m.remove(i.id);
  expect(m.stats.total).toBe(0);
  expect(m.stats.percentage).toBe(0);
});
