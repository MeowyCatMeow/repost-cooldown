import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withRetries } from '../src/core/retry.ts';

/** An action that fails the given number of times and then answers, and a record of the waiting done between tries. */
function flaky(failures: number) {
  const waits: number[] = [];
  const reported: Array<[string, number]> = [];
  let calls = 0;
  return {
    waits,
    reported,
    calls: () => calls,
    action: async () => {
      calls++;
      if (calls <= failures) throw new Error(`failure ${calls}`);
      return `answer on try ${calls}`;
    },
    wait: async (ms: number) => {
      waits.push(ms);
    },
    onFailure: (error: unknown, triesLeft: number) => {
      reported.push([String(error), triesLeft]);
    },
  };
}

test('an action that works at once is run once, with no waiting', async () => {
  const f = flaky(0);
  assert.equal(await withRetries(f.action, [1500, 4000], f.wait, f.onFailure), 'answer on try 1');
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.waits, []);
  assert.deepEqual(f.reported, []);
});

test('a failed action is tried again after each pause, in order', async () => {
  const once = flaky(1);
  assert.equal(await withRetries(once.action, [1500, 4000], once.wait, once.onFailure), 'answer on try 2');
  assert.deepEqual(once.waits, [1500]);
  assert.deepEqual(once.reported, [['Error: failure 1', 2]]);

  const twice = flaky(2);
  assert.equal(await withRetries(twice.action, [1500, 4000], twice.wait, twice.onFailure), 'answer on try 3');
  assert.deepEqual(twice.waits, [1500, 4000]);
  assert.deepEqual(twice.reported, [
    ['Error: failure 1', 2],
    ['Error: failure 2', 1],
  ]);
});

test('when every try fails, the last failure is thrown and nothing waits after it', async () => {
  const f = flaky(3);
  await assert.rejects(withRetries(f.action, [1500, 4000], f.wait, f.onFailure), /failure 3/);
  assert.equal(f.calls(), 3);
  assert.deepEqual(f.waits, [1500, 4000]);
  // The last failure is not reported as one that will be tried again.
  assert.equal(f.reported.length, 2);
});

test('with no pauses there is one try only', async () => {
  const f = flaky(1);
  await assert.rejects(withRetries(f.action, [], f.wait), /failure 1/);
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.waits, []);
});
