// When are swaps "slow"? Pure so it can be unit-tested (week8.test.ts).
// One swap over 2× the limit, or two in a row over the limit → stack both layers on one screen.
export function slowVerdict(times: number[], slowMs: number): string | null {
  const last = times[times.length - 1], prev = times[times.length - 2];
  if (last == null) return null;
  if (last >= 2 * slowMs) return `a swap took ${(last / 1000).toFixed(1)} s`;
  if (prev != null && last >= slowMs && prev >= slowMs) return `two swaps in a row took over ${(slowMs / 1000).toFixed(1)} s`;
  return null;
}
