import fs from "fs";
import path from "path";
import { WATCHED_IMAGE_FILE_RE } from "./config/constants.js";
import { appEnv } from "./config/env.js";
import { ImmichClient } from "./services/ImmichClient.js";
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

  private readonly immich = new ImmichClient(
    appEnv.immichUrl,
    appEnv.immichApiKey,
    this.logger.child("immich"),
  );

  private readonly workerPool = new WorkerPool(appEnv.concurrency, (error) => {
    this.logger.error("Worker task failed", { error: errorToString(error) });
  });

  private readonly inFlightAssetIds = new Set<string>();

  async run(): Promise<void> {
    await this.startPolling();
  }

  private resolveExistingPhotoPath(filePath: string): string | null {
    const candidates = new Set<string>();

    const addCandidate = (value: string | null | undefined): void => {
      if (!value) return;
      candidates.add(value);
      candidates.add(value.normalize("NFC"));
      candidates.add(value.normalize("NFD"));

      try {
        const decoded = decodeURIComponent(value);
        candidates.add(decoded);
        candidates.add(decoded.normalize("NFC"));
        candidates.add(decoded.normalize("NFD"));
      } catch {
        // ignore
      }
    };

    addCandidate(filePath);
    addCandidate(filePath.replace(/\+/g, " "));

    for (const candidate of Array.from(candidates)) {
      addCandidate(this.stripDuplicateImageExtension(candidate));
    }

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }

    for (const candidate of candidates) {
      const matched = this.matchFileInDirectory(candidate);
      if (matched) return matched;
    }

    return null;
  }

  private matchFileInDirectory(filePath: string): string | null {
    const dirPath = path.dirname(filePath);
    if (!fs.existsSync(dirPath)) return null;

    let entries: string[];
    try {
      entries = fs.readdirSync(dirPath);
    } catch {
      return null;
    }

    const wantedBasename = path.basename(filePath);
    const wantedKey = this.toLooseFileKey(wantedBasename);
    const wantedStemKey = this.toStemKey(wantedBasename);
    if (!wantedKey) return null;

    for (const entry of entries) {
      if (this.toLooseFileKey(entry) === wantedKey) {
        return path.join(dirPath, entry);
      }
    }

    if (!wantedStemKey) return null;
    for (const entry of entries) {
      if (this.toStemKey(entry) === wantedStemKey) {
        return path.join(dirPath, entry);
      }
    }

    return null;
  }

  private toLooseFileKey(value: string): string {
    const normalized = value.trim();
    if (!normalized) return "";
    const stripped = this.stripDuplicateImageExtension(normalized);
    return stripped.normalize("NFC").toLowerCase();
  }

  private toStemKey(value: string): string {
    const normalized = value.trim();
    if (!normalized) return "";
    const lowered = normalized.normalize("NFC").toLowerCase();
    const stem = lowered.replace(/(\.(?:png|webp|jpe?g))+$/i, "");
    return stem;
  }

  private stripDuplicateImageExtension(value: string): string {
    return value.replace(/(\.(?:png|webp|jpe?g))\.(?:png|webp|jpe?g)$/i, "$1");
  }

  private async processResolvedAsset(
    assetId: string,
    filePath: string,
    filename: string,
  ): Promise<void> {
    const resolvedFilePath = this.resolveExistingPhotoPath(filePath);
    if (!resolvedFilePath) {
      this.logger.warn("Asset source file does not exist", {
        assetId,
        filePath,
      });
      return;
    }

    if (resolvedFilePath !== filePath) {
      this.logger.info("Resolved asset source path", {
        assetId,
        from: filePath,
        to: resolvedFilePath,
      });
    }

    await waitForStable(resolvedFilePath);

    const prompt = await extractPrompt(resolvedFilePath, {
      logger: this.logger,
    });
    if (!prompt) {
      this.logger.warn("No prompt found", {
        assetId,
        filePath: resolvedFilePath,
      });
      return;
    }

    // ✅ 기존 라벨 파싱 로직 그대로 활용
    const albumNames: string[] = [];
    albumNames.push(...parsePositivePromptLabels(prompt));
    const modelAlbum = parseModelPromptLabel(prompt);
    if (modelAlbum) albumNames.push(modelAlbum);

    // ✅ 처리 마커 앨범(필수): 이 앨범에 들어간 애들은 "처리됨"으로 간주하게 할 수도 있음
    const markerAlbumName = appEnv.markerLabel; // 예: "_labeled_v1"
    if (markerAlbumName?.trim()) albumNames.push(markerAlbumName);

    const uniqueAlbumNames = Array.from(
      new Set(albumNames.map((v) => v.trim()).filter(Boolean)),
    );

    if (!uniqueAlbumNames.length) {
      this.logger.warn("No album names parsed from prompt", {
        assetId,
        filePath: resolvedFilePath,
      });
      return;
    }

    // 앨범이 없으면 생성 후 추가
    let albumsApplied = 0;
    for (const name of uniqueAlbumNames) {
      const albumId = await this.immich.getOrCreateAlbumId(name);
      if (!albumId) continue;
      await this.immich.addAssetsToAlbum(albumId, [assetId]);
      albumsApplied += 1;
    }

    this.logger.info("Asset processed", {
      filename,
      assetId,
      albumsApplied,
    });
  }

  private async runPollCycle(): Promise<void> {
    const assets = await this.immich.listAssetsNotInAnyAlbum(appEnv.pollCount);

    let queued = 0;
    let skipped = 0;

    for (const asset of assets) {
      if (this.inFlightAssetIds.has(asset.id)) {
        skipped += 1;
        continue;
      }

      const filePath = asset.originalPath;
      const filename = asset.originalFileName;

      if (!filePath || !WATCHED_IMAGE_FILE_RE.test(filePath)) {
        skipped += 1;
        this.logger.debug("Skipping unsupported file in asset scan", {
          assetId: asset.id,
          filePath,
        });
        continue;
      }

      this.inFlightAssetIds.add(asset.id);
      queued += 1;

      this.workerPool.enqueue(async () => {
        try {
          await this.processResolvedAsset(asset.id, filePath, filename);
        } finally {
          this.inFlightAssetIds.delete(asset.id);
        }
      });
    }

    this.logger.info("Poll cycle queued", {
      found: assets.length,
      queued,
      skipped,
      inFlight: this.inFlightAssetIds.size,
    });
  }

  private async startPolling(): Promise<void> {
    this.logger.info("Polling started", {
      pollIntervalMs: appEnv.pollIntervalMs,
      pollCount: appEnv.pollCount,
      uploadOrExternalHint: "Immich originalPath",
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
