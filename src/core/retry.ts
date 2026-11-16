/**
 * Runs `action`, and runs it again when it fails, after a pause. There is one
 * new try for each entry in `pausesMs`, which says how long to wait before it.
 * Returns the result of the first try that works, or throws what the last try
 * threw.
 *
 * `wait` does the waiting, so that a test need not. `onFailure` is told about
 * each failure that is followed by another try, and how many tries are left.
 */
export async function withRetries<T>(
  action: () => Promise<T>,
  pausesMs: readonly number[],
  wait: (ms: number) => Promise<void>,
  onFailure?: (error: unknown, triesLeft: number) => void
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      const pause = pausesMs[attempt];
      if (pause === undefined) throw error;
      onFailure?.(error, pausesMs.length - attempt);
      await wait(pause);
    }
  }
}
