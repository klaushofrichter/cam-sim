// `run`, at most once at a time: calls while one runs queue a single more,
// which starts after the last call, so its result is never older than it.
export function coalesced(run: () => Promise<unknown>): () => void {
  let running = false;
  let again = false;
  const go = (): void => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    void run().finally(() => {
      running = false;
      if (again) {
        again = false;
        go();
      }
    });
  };
  return go;
}
