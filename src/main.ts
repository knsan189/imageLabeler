import chokidar from "chokidar";
import path from "path";
import {
  PHOTO_UID_LOOKUP_ATTEMPTS,
  PHOTO_UID_LOOKUP_INTERVAL_MS,
  WATCHED_IMAGE_FILE_RE,
  WATCHER_OPTIONS,
} from "./config/constants.js";
import { appEnv } from "./config/env.js";
import { PhotoPrismClient } from "./services/PhotoPrismClient.js";
import { extractPrompt } from "./utils/extractPrompt.js";
import { waitForStable } from "./utils/fileStability.js";
import { errorToString, Logger } from "./utils/logger.js";
import { parsePositivePromptLabels } from "./utils/promptLabels.js";
import { WorkerPool } from "./utils/workerPool.js";

class PngTaggerApp {
  private readonly logger = new Logger("pngTagger", appEnv.logLevel);
  private readonly photoPrism = new PhotoPrismClient(
    appEnv.photoPrismUrl,
    appEnv.photoPrismToken,
    this.logger.child("photoPrism")
  );
  private readonly workerPool = new WorkerPool(
    appEnv.concurrency,
    (error) => {
      this.logger.error("Worker task failed", { error: errorToString(error) });
    }
  );

  async run(): Promise<void> {
    const singleRunFilePath = this.resolveSingleRunFilePath();
    if (singleRunFilePath) {
      if (!WATCHED_IMAGE_FILE_RE.test(singleRunFilePath)) {
        throw new Error(`Unsupported file extension: ${singleRunFilePath}`);
      }

      this.logger.info("Single-run mode started", { filePath: singleRunFilePath });
      await this.processFile(singleRunFilePath);
      this.logger.info("Single-run mode finished");
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
    this.logger.info("Processing file", { filePath });

    await waitForStable(filePath);

    const prompt = await extractPrompt(filePath, { logger: this.logger });
    if (!prompt) {
      this.logger.warn("No prompt found", { filePath });
      return;
    }

    const labels = parsePositivePromptLabels(prompt);
    if (!labels.length) {
      this.logger.warn("No labels parsed from prompt", { filePath });
      return;
    }

    const filename = path.basename(filePath);
    const folderPath = path
      .relative(appEnv.originalsPath, filePath)
      .replace(`/${filename}`, "");
    this.logger.info("Resolving Photo UID", {
      filename,
      folderPath,
      labels: labels.length,
    });

    const uid = await this.photoPrism.waitForPhotoUidByFilename(filename, folderPath, {
      attempts: PHOTO_UID_LOOKUP_ATTEMPTS,
      intervalMs: PHOTO_UID_LOOKUP_INTERVAL_MS,
    });

    if (!uid) {
      this.logger.warn("Photo UID not found", { filename, folderPath });
      return;
    }

    for (const label of labels) {
      await this.photoPrism.addLabel(uid, label);
    }

    // await this.photoPrism.addLabel(uid, appEnv.markerLabel);
    this.logger.info("File processed", { filename, uid, labelsApplied: labels.length + 1 });
  }

  private startWatcher(): void {
    chokidar.watch(appEnv.originalsPath, WATCHER_OPTIONS).on("add", (filePath) => {
      if (!WATCHED_IMAGE_FILE_RE.test(filePath)) return;
      this.workerPool.enqueue(() => this.processFile(filePath));
    });

    this.logger.info("Watcher started", {
      originalsPath: appEnv.originalsPath,
      concurrency: appEnv.concurrency,
    });
  }
}

void new PngTaggerApp().run().catch((error) => {
  const logger = new Logger("pngTagger", appEnv.logLevel);
  logger.error("Fatal error", { error: errorToString(error) });
  process.exitCode = 1;
});
