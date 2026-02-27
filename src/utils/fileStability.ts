import fs from "fs/promises";
import { sleep } from "./sleep";

export type WaitForStableOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
};

export async function waitForStable(
  filePath: string,
  options: WaitForStableOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;

  const start = Date.now();
  let lastSize = -1;

  while (Date.now() - start < timeoutMs) {
    let currentSize = -1;
    try {
      const stats = await fs.stat(filePath);
      currentSize = stats.size;
    } catch {
      return;
    }

    if (currentSize === lastSize) return;
    lastSize = currentSize;

    await sleep(pollIntervalMs);
  }
}
