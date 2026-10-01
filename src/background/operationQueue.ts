export function createOperationQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return { run<T>(job: () => Promise<T>): Promise<T> {
    const next = tail.then(job); tail = next.catch(() => undefined); return next;
  } };
}
