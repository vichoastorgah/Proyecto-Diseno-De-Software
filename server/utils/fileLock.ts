/**
 * @module utils/fileLock
 * Process-wide write lock built on a single promise queue.
 *
 * Every read-modify-write cycle on the JSON "database" files (`voters.json`,
 * `motions.json`, `data.json`) must go through {@link withWriteLock}. Because all
 * services import this same module instance, tasks are serialized across services,
 * which prevents lost updates when two requests touch the same file concurrently.
 *
 * Limitations:
 * - It only protects a single Deno process (not multiple server instances).
 * - It is NOT re-entrant: calling `withWriteLock` from inside a locked task
 *   waits for itself and deadlocks. Inside a task, use the unlocked helpers.
 */

/** Tail of the queue: settles when the most recently queued task has finished. */
let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * Runs `task` after every previously queued task has settled.
 * A failing task rejects only its own promise; later tasks still run.
 *
 * @param task Async function performing the read-modify-write cycle.
 * @returns The task's result (or its rejection).
 */
export function withWriteLock<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}