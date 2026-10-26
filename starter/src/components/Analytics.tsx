import type { summary } from '../model';
export default function Analytics({
  stats,
}: {
  stats: ReturnType<typeof summary>;
}) {
  void stats;
  return (
    <section aria-label="Analytics">
      <h2>Project summary</h2>
      <p>Project analytics will appear here.</p>
      <output aria-label="Total issues">0</output>
      <output aria-label="Completed issues">0</output>
      <output aria-label="Completion percentage">0%</output>
    </section>
  );
}
