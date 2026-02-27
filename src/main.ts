import chokidar from "chokidar";
import path from "path";
import {
  PHOTO_UID_LOOKUP_ATTEMPTS,
  PHOTO_UID_LOOKUP_INTERVAL_MS,
  WATCHED_IMAGE_FILE_RE,
  WATCHER_OPTIONS,
} from "./config/constants";
import { appEnv } from "./config/env";
import { PhotoPrismClient } from "./services/PhotoPrismClient";
import { extractPrompt } from "./utils/extractPrompt";
import { waitForStable } from "./utils/fileStability";
import { parsePositivePromptLabels } from "./utils/promptLabels";
import { WorkerPool } from "./utils/workerPool";

class PngTaggerApp {
  private readonly photoPrism = new PhotoPrismClient(
    appEnv.photoPrismUrl,
    appEnv.photoPrismToken
  );
  private readonly workerPool = new WorkerPool(appEnv.concurrency);

  async run(): Promise<void> {
    const singleRunFilePath = this.resolveSingleRunFilePath();
    if (singleRunFilePath) {
      if (!WATCHED_IMAGE_FILE_RE.test(singleRunFilePath)) {
        throw new Error(`Unsupported file extension: ${singleRunFilePath}`);
      }

      console.log("pngTagger single-run mode:", singleRunFilePath);
      await this.processFile(singleRunFilePath);
      console.log("pngTagger single-run finished");
      return;
    }

    this.startWatcher();
  }

  private getCliOptionValue(option: string): string | null {
    const index = process.argv.indexOf(option);
    if (index < 0) return null;
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${option}`);
    }
    return value;
  }

  private resolveSingleRunFilePath(): string | null {
    const fromCli = this.getCliOptionValue("--file");
    if (fromCli) return path.resolve(fromCli);

    const fromEnv = process.env.ONE_SHOT_FILE?.trim();
    if (fromEnv) return path.resolve(fromEnv);

    return null;
  }

  private async processFile(filePath: string): Promise<void> {
    console.log("Processing:", filePath);

    await waitForStable(filePath);

    const prompt = await extractPrompt(filePath);
    if (!prompt) {
      console.log("No prompt found:", filePath);
      return;
    }

    const labels = parsePositivePromptLabels(prompt);
    if (!labels.length) {
      console.log("No labels parsed:", filePath);
      return;
    }

    const filename = path.basename(filePath);
    const uid = await this.photoPrism.waitForPhotoUidByFilename(filename, {
      attempts: PHOTO_UID_LOOKUP_ATTEMPTS,
      intervalMs: PHOTO_UID_LOOKUP_INTERVAL_MS,
    });

    if (!uid) {
      console.log("UID not found:", filename);
      return;
    }

    for (const label of labels) {
      await this.photoPrism.addLabel(uid, label);
    }

    await this.photoPrism.addLabel(uid, appEnv.markerLabel);
    console.log("Done:", filename);
  }

  private startWatcher(): void {
    chokidar.watch(appEnv.originalsPath, WATCHER_OPTIONS).on("add", (filePath) => {
      if (!WATCHED_IMAGE_FILE_RE.test(filePath)) return;
      this.workerPool.enqueue(() => this.processFile(filePath));
    });

    console.log("pngTagger watcher started");
  }
}

void new PngTaggerApp().run().catch((error) => {
  console.error("pngTagger fatal error:", error);
  process.exitCode = 1;
});
