import chokidar from "chokidar";
import fs from "fs";
import fg from "fast-glob";
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
import {
  parseModelPromptLabel,
  parsePositivePrompt,
  parsePositivePromptLabels,
} from "./utils/promptLabels.js";
import { WorkerPool } from "./utils/workerPool.js";

class PngTaggerApp {
  private readonly logger = new Logger("pngTagger", appEnv.logLevel);
  private readonly watchPath = this.resolveWatchPath();
  private readonly status = {
    isWatching: false,
    uploadedFilesCount: 0,
  };
  private readonly photoPrism = new PhotoPrismClient(
    appEnv.photoPrismUrl,
    appEnv.photoPrismToken,
    this.logger.child("photoPrism"),
  );
  private readonly workerPool = new WorkerPool(appEnv.concurrency, (error) => {
    this.logger.error("Worker task failed", { error: errorToString(error) });
  });

  async run(): Promise<void> {
    const singleRunFilePath = this.resolveSingleRunFilePath();
    if (singleRunFilePath) {
      if (!WATCHED_IMAGE_FILE_RE.test(singleRunFilePath)) {
        throw new Error(`Unsupported file extension: ${singleRunFilePath}`);
      }

      this.logger.info("Single-run mode started", {
        filePath: singleRunFilePath,
      });
      await this.processFile(singleRunFilePath);
      this.logger.info("Single-run mode finished");
      return;
    }

    if (this.hasCliFlag("--bootstrap")) {
      await this.runBootstrap();
      return;
    }

    this.startWatcher();
  }

  private hasCliFlag(flag: string): boolean {
    return process.argv.includes(flag);
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

  private resolveWatchPath(): string {
    const fromCli = this.getCliOptionValue("--watch-path");
    if (fromCli) return path.resolve(fromCli);

    const fromEnv = process.env.WATCH_PATH?.trim();
    if (fromEnv) return path.resolve(fromEnv);

    const candidates = ["upload", "uploads", "import", "imports"];
    for (const name of candidates) {
      const candidatePath = path.join(appEnv.originalsPath, name);
      if (fs.existsSync(candidatePath)) {
        return candidatePath;
      }
    }

    return path.join(appEnv.originalsPath, "temp");
  }

  private resolvePhotoPath(filePath: string): {
    filename: string;
    folderPath: string;
  } {
    const filename = path.basename(filePath);
    const relativePath = path.relative(appEnv.originalsPath, filePath);
    const relativeDir = path.dirname(relativePath);
    const folderPath =
      relativeDir === "." ? "" : relativeDir.split(path.sep).join("/");

    return { filename, folderPath };
  }

  private async runBootstrap(): Promise<void> {
    this.logger.info("Bootstrap mode started", {
      originalsPath: appEnv.originalsPath,
      concurrency: appEnv.bootstrapConcurrency,
    });

    const files = await fg("**/*.{png,webp,jpg,jpeg}", {
      cwd: appEnv.originalsPath,
      absolute: true,
      onlyFiles: true,
      caseSensitiveMatch: false,
      followSymbolicLinks: false,
      suppressErrors: true,
    });

    this.logger.info("Bootstrap scan finished", {
      filesFound: files.length,
      originalsPath: appEnv.originalsPath,
    });

    for (const filePath of files) {
      this.workerPool.enqueue(() => this.processFile(filePath));
    }

    this.logger.info("Bootstrap tasks queued", {
      queued: files.length,
      concurrency: appEnv.concurrency,
    });

    await this.workerPool.onIdle();

    this.logger.info("Bootstrap mode finished", {
      queued: files.length,
    });
  }

  private async processFile(filePath: string): Promise<void> {
    this.logger.info("Processing file", { filePath });

    await waitForStable(filePath);

    const { filename, folderPath } = this.resolvePhotoPath(filePath);

    this.logger.info("Resolving Photo UID", {
      filename,
      folderPath,
    });

    const uid = await this.photoPrism.waitForPhotoUidByFilename(
      filename,
      folderPath,
      {
        attempts: PHOTO_UID_LOOKUP_ATTEMPTS,
        intervalMs: PHOTO_UID_LOOKUP_INTERVAL_MS,
      },
    );

    if (!uid) {
      this.logger.warn("Photo UID not found", { filename, folderPath });
      return;
    }

    const alreadyImported = await this.photoPrism.hasLabel(
      uid,
      appEnv.markerLabel,
    );

    if (alreadyImported) {
      this.logger.info("Skipping already imported photo", {
        filename,
        uid,
        markerLabel: appEnv.markerLabel,
      });
      return;
    }

    const prompt = await extractPrompt(filePath, { logger: this.logger });

    if (!prompt) {
      this.logger.warn("No prompt found", { filePath });
      return;
    }

    const positivePrompt = parsePositivePrompt(prompt);
    this.logger.info("Updating photo");
    await this.photoPrism.updatePhoto(uid, prompt, positivePrompt);

    const labels: string[] = [];
    const positiveLabels = parsePositivePromptLabels(positivePrompt);

    labels.push(...positiveLabels);
    const modelLabel = parseModelPromptLabel(prompt);
    if (modelLabel) labels.push(modelLabel);

    if (!labels.length) {
      this.logger.warn("No labels parsed from prompt", { filePath });
      return;
    }

    for (const label of labels) {
      await this.photoPrism.addLabel(uid, label);
    }

    await this.photoPrism.addLabel(uid, appEnv.markerLabel, 10);
    this.logger.info("File processed", {
      filename,
      uid,
      labelsApplied: labels.length + 1,
    });
  }

  private logWatchStatus(): void {
    if (!this.status.isWatching) return;
    this.logger.info(
      `[Main] Status: Watching=${this.status.isWatching}, Uploaded=${this.status.uploadedFilesCount}`,
    );
  }

  private startWatcher(): void {
    this.status.isWatching = true;

    chokidar.watch(this.watchPath, WATCHER_OPTIONS).on("add", (filePath) => {
      if (!WATCHED_IMAGE_FILE_RE.test(filePath)) return;
      this.status.uploadedFilesCount += 1;
      this.workerPool.enqueue(() => this.processFile(filePath));
    });

    this.logger.info("Watcher started", {
      watchPath: this.watchPath,
      originalsPath: appEnv.originalsPath,
      concurrency: appEnv.concurrency,
    });

    setInterval(() => {
      this.logWatchStatus();
    }, 10_000);
  }
}

void new PngTaggerApp().run().catch((error) => {
  const logger = new Logger("pngTagger", appEnv.logLevel);
  logger.error("Fatal error", { error: errorToString(error) });
  process.exitCode = 1;
});
