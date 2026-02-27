type Task = () => Promise<void>;

export class WorkerPool {
  private readonly queue: Task[] = [];
  private activeCount = 0;
  private readonly concurrency: number;

  constructor(concurrency: number) {
    this.concurrency = Math.max(1, Math.floor(concurrency));
  }

  enqueue(task: Task): void {
    this.queue.push(task);
    this.runNext();
  }

  private runNext(): void {
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) return;

      this.activeCount += 1;

      void Promise.resolve()
        .then(task)
        .catch((error) => {
          console.error(error);
        })
        .finally(() => {
          this.activeCount -= 1;
          this.runNext();
        });
    }
  }
}
