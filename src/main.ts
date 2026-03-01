import fs from "fs";
import fg from "fast-glob";
import path from "path";
import {
  PHOTO_UID_LOOKUP_ATTEMPTS,
  PHOTO_UID_LOOKUP_INTERVAL_MS,
  WATCHED_IMAGE_FILE_RE,
} from "./config/constants.js";
import { appEnv } from "./config/env.js";
import { PhotoPrismClient } from "./services/PhotoPrismClient.js";
import { extractPrompt } from "./utils/extractPrompt.js";
import { waitForStable } from "./utils/fileStability.js";
import { errorToString, Logger } from "./utils/logger.js";
import {
  parseModelPromptLabel,
  parsePositivePromptLabels,
} from "./utils/promptLabels.js";
import { sleep } from "./utils/sleep.js";
import { WorkerPool } from "./utils/workerPool.js";

class PngTaggerApp {
  private readonly logger = new Logger("pngTagger", appEnv.logLevel);
  private readonly photoPrism = new PhotoPrismClient(
    appEnv.photoPrismUrl,
    appEnv.photoPrismToken,
    this.logger.child("photoPrism"),
  );
  private readonly workerPool = new WorkerPool(appEnv.concurrency, (error) => {
    this.logger.error("Worker task failed", { error: errorToString(error) });
  });
  private readonly inFlightPhotoUids = new Set<string>();

  async run(): Promise<void> {
    await this.startPolling();
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

  private async processResolvedPhoto(
    uid: string,
    filePath: string,
    filename: string,
  ): Promise<void> {
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

    if (!fs.existsSync(filePath)) {
      this.logger.warn("Photo source file does not exist", {
        uid,
        filePath,
      });
      return;
    }

    await this.photoPrism.addLabel(uid, appEnv.markerLabel, 10);

    const prompt = await extractPrompt(filePath, { logger: this.logger });

    if (!prompt) {
      this.logger.warn("No prompt found", { uid, filePath });
      return;
    }

    const labels: string[] = [];
    labels.push(...parsePositivePromptLabels(prompt));
    const modelLabel = parseModelPromptLabel(prompt);
    if (modelLabel) labels.push(modelLabel);

    if (!labels.length) {
      this.logger.warn("No labels parsed from prompt", { uid, filePath });
      return;
    }

    for (const label of labels) {
      await this.photoPrism.addLabel(uid, label);
    }

    this.logger.info("File processed", {
      filename,
      uid,
      labelsApplied: labels.length + 1,
    });
  }

  private toAbsolutePhotoPath(folderPath: string, filename: string): string {
    const normalizedDir = folderPath
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "");
    const segments = normalizedDir ? normalizedDir.split("/") : [];
    return path.join(appEnv.originalsPath, ...segments, filename);
  }

  private async runPollCycle(): Promise<void> {
    const captionlessPhotos = await this.photoPrism.listCaptionlessPhotos(
      appEnv.pollCount,
    );

    let queued = 0;
    let skipped = 0;

    for (const photo of captionlessPhotos) {
      if (this.inFlightPhotoUids.has(photo.uid)) {
        skipped += 1;
        continue;
      }

      const filePath = this.toAbsolutePhotoPath(
        photo.folderPath,
        photo.filename,
      );
      if (!WATCHED_IMAGE_FILE_RE.test(filePath)) {
        skipped += 1;
        this.logger.debug("Skipping unsupported file in captionless scan", {
          uid: photo.uid,
          filePath,
        });
        continue;
      }

      this.inFlightPhotoUids.add(photo.uid);
      queued += 1;
      this.workerPool.enqueue(async () => {
        try {
          await this.processResolvedPhoto(photo.uid, filePath, photo.filename);
        } finally {
          this.inFlightPhotoUids.delete(photo.uid);
        }
      });
    }

    this.logger.info("Poll cycle queued", {
      found: captionlessPhotos.length,
      queued,
      skipped,
      inFlight: this.inFlightPhotoUids.size,
    });
  }

  private async startPolling(): Promise<void> {
    this.logger.info("Polling started", {
      pollIntervalMs: appEnv.pollIntervalMs,
      pollCount: appEnv.pollCount,
      originalsPath: appEnv.originalsPath,
      concurrency: appEnv.concurrency,
    });

    while (true) {
      const startedAt = Date.now();
      try {
        await this.runPollCycle();
        await this.workerPool.onIdle();
      } catch (error) {
        this.logger.error("Poll cycle failed", {
          error: errorToString(error),
        });
      }

      const elapsedMs = Date.now() - startedAt;
      const waitMs = Math.max(0, appEnv.pollIntervalMs - elapsedMs);
      this.logger.debug("Poll cycle finished", { elapsedMs, waitMs });
      await sleep(waitMs);
    }
  }
}

void new PngTaggerApp().run().catch((error) => {
  const logger = new Logger("pngTagger", appEnv.logLevel);
  logger.error("Fatal error", { error: errorToString(error) });
  process.exitCode = 1;
});
