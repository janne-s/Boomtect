/** One replaceable async task. Ownership survives an abort until finish/cancel clears it. */
export function createLatestTask() {
  let active = null;
  return {
    get busy() { return active !== null; },
    start(timeoutMilliseconds = null) {
      this.cancel();
      const controller = new AbortController();
      const task = {
        signal: controller.signal,
        current: () => active === task,
        abort: () => controller.abort(),
        timer: timeoutMilliseconds === null ? null : setTimeout(() => controller.abort(), timeoutMilliseconds)
      };
      active = task;
      return task;
    },
    finish(task) {
      if (active !== task) return false;
      clearTimeout(task.timer);
      active = null;
      task.abort();
      return true;
    },
    cancel() {
      if (!active) return;
      clearTimeout(active.timer);
      active.abort();
      active = null;
    }
  };
}
