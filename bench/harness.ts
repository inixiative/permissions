export type Result = { name: string; p50: number; p99: number; mean: number };

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;

export const measure = (name: string, fn: (i: number) => unknown, samples = 20_000): Result => {
  let sink = 0;
  for (let i = 0; i < 2_000; i++) sink += fn(i) ? 1 : 0;
  Bun.gc(true);
  const times = new Float64Array(samples);
  for (let i = 0; i < samples; i++) {
    const start = Bun.nanoseconds();
    sink += fn(i) ? 1 : 0;
    times[i] = Bun.nanoseconds() - start;
  }
  if (sink < 0) console.log(sink);
  const sorted = [...times].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, t) => sum + t, 0) / sorted.length;
  return {
    name,
    p50: percentile(sorted, 0.5) / 1e3,
    p99: percentile(sorted, 0.99) / 1e3,
    mean: mean / 1e3,
  };
};

export const report = (title: string, results: Result[]) => {
  console.log(`\n## ${title} (µs per call)`);
  console.table(
    results.map(({ name, p50, p99, mean }) => ({
      case: name,
      p50: +p50.toFixed(2),
      p99: +p99.toFixed(2),
      mean: +mean.toFixed(2),
    })),
  );
};
