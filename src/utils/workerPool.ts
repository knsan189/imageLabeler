type Task = () => Promise<void>;

export class WorkerPool {
  private readonly queue: Task[] = [];
  private activeCount = 0;
  private readonly idleResolvers: Array<() => void> = [];
  private readonly concurrency: number;
  private readonly onError?: (error: unknown) => void;

  constructor(concurrency: number, onError?: (error: unknown) => void) {
    this.concurrency = Math.max(1, Math.floor(concurrency));
    this.onError = onError;
  }

  enqueue(task: Task): void {
    this.queue.push(task);
    this.runNext();
  }

  onIdle(): Promise<void> {
    if (this.queue.length === 0 && this.activeCount === 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  private runNext(): void {
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) return;

      this.activeCount += 1;

      void Promise.resolve()
        .then(task)
        .catch((error) => {
          if (this.onError) {
            this.onError(error);
            return;
          }
          console.error(error);
        })
        .finally(() => {
          this.activeCount -= 1;
          this.runNext();
        });
    }

    if (this.queue.length === 0 && this.activeCount === 0) {
      const pendingResolvers = this.idleResolvers.splice(0);
      for (const resolve of pendingResolvers) {
        resolve();
      }
    }
  }
}
