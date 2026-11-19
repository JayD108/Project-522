import { describe, expect, it } from 'vitest';
import { slowVerdict } from './stacking';

describe('slow swaps → stacked layers', () => {
  it('fast swaps never stack', () => {
    expect(slowVerdict([], 1000)).toBeNull();
    expect(slowVerdict([130, 180, 190, 999], 1000)).toBeNull();
  });
  it('one slow swap alone is not enough', () => {
    expect(slowVerdict([150, 1200], 1000)).toBeNull();
    expect(slowVerdict([1200, 150], 1000)).toBeNull();
  });
  it('two slow swaps in a row stack', () => {
    expect(slowVerdict([150, 1100, 1300], 1000)).toMatch(/two swaps in a row/);
  });
  it('one very slow swap (≥ 2× the limit) stacks at once', () => {
    expect(slowVerdict([150, 2400], 1000)).toBe('a swap took 2.4 s');
  });
});
