import axios, { AxiosInstance } from "axios";
import path from "path";
import { sleep } from "../utils/sleep.js";
import { errorToString, LoggerLike } from "../utils/logger.js";

type WaitForUidOptions = {
  attempts?: number;
  intervalMs?: number;
};

type PhotoFileRef = {
  FileName?: string;
  Name?: string;
  Path?: string;
};

type PhotoItem = {
  UID?: string;
  FileName?: string;
  Name?: string;
  Path?: string;
  Files?: PhotoFileRef[];
};

type PhotoLabel = {
  Name?: string;
  Label?: {
    Name?: string;
  };
};

type PhotoDetails = {
  UID?: string;
  FileName?: string;
  Name?: string;
  Path?: string;
  Files?: PhotoFileRef[];
  Labels?: PhotoLabel[];
  PhotoLabels?: PhotoLabel[];
};

export type CaptionlessPhoto = {
  uid: string;
  filename: string;
  folderPath: string;
};

export class PhotoPrismClient {
  private readonly http: AxiosInstance;
  private readonly logger?: LoggerLike;

  constructor(baseUrl: string, token: string, logger?: LoggerLike) {
    this.http = axios.create({
      baseURL: baseUrl.replace(/\/+$/, ""),
      headers: {
        Authorization: `Bearer ${token}`,
      },
      timeout: 30_000,
    });
    this.logger = logger;
  }

  async findPhotoUidByFilename(
    filename: string,
    relDir: string
  ): Promise<string | null> {
    try {
      const q = `path:"${relDir}" name:"${filename}"`;
      const res = await this.http.get<PhotoItem[]>("/api/v1/photos", {
        params: {
          q,
          count: 1,
        },
      });
      return res.data?.[0]?.UID ?? null;
    } catch (error) {
      this.logger?.warn("Photo UID lookup request failed", {
        filename,
        relDir,
        error: errorToString(error),
      });
      return null;
    }
  }

  async waitForPhotoUidByFilename(
    filename: string,
    relDir: string,
    options: WaitForUidOptions = {}
  ): Promise<string | null> {
    const attempts = options.attempts ?? 20;
    const intervalMs = options.intervalMs ?? 3_000;

    for (let i = 0; i < attempts; i += 1) {
      const uid = await this.findPhotoUidByFilename(filename, relDir);
      this.logger?.debug("Photo UID lookup result", {
        filename,
        relDir,
        attempt: i + 1,
        attempts,
        uid,
      });
      if (uid) return uid;
      await sleep(intervalMs);
    }

    return null;
  }

  async addLabel(uid: string, label: string, priority: number = 0): Promise<void> {
    try {
      await this.http.post(`/api/v1/photos/${uid}/label`, {
        Name: label,
        Priority: priority,
        Uncertainty: 0,
      });
    } catch (error) {
      this.logger?.warn("Failed to add label", {
        uid,
        label,
        error: errorToString(error),
      });
    }
  }

  async hasLabel(uid: string, label: string): Promise<boolean> {
    try {
      const res = await this.http.get<PhotoDetails>(`/api/v1/photos/${uid}`);
      const target = label.trim().toLowerCase();
      if (!target) return false;

      const names = [
        ...(res.data?.Labels ?? []),
        ...(res.data?.PhotoLabels ?? []),
      ]
        .map((item) => item.Name ?? item.Label?.Name ?? "")
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name.length > 0);

      return names.includes(target);
    } catch (error) {
      this.logger?.warn("Failed to read photo labels", {
        uid,
        label,
        error: errorToString(error),
      });
      return false;
    }
  }

  async listCaptionlessPhotos(count: number = 300): Promise<CaptionlessPhoto[]> {
    const limit = Math.max(1, Math.floor(count));

    try {
      const res = await this.http.get<PhotoItem[]>("/api/v1/photos", {
        params: {
          count: limit,
          q: 'Caption:""',
        },
      });

      const items = res.data ?? [];
      const result: CaptionlessPhoto[] = [];
      const unresolvedUids: string[] = [];
      const seenUids = new Set<string>();

      for (const item of items) {
        const uid = this.clean(item.UID);
        if (!uid || seenUids.has(uid)) continue;
        seenUids.add(uid);

        const location = this.resolveLocation(item);
        if (!location) {
          unresolvedUids.push(uid);
          continue;
        }

        result.push({
          uid,
          filename: location.filename,
          folderPath: location.folderPath,
        });
      }

      if (unresolvedUids.length > 0) {
        const resolved = await Promise.all(
          unresolvedUids.map(async (uid) => ({
            uid,
            location: await this.fetchLocationByUid(uid),
          })),
        );

        for (const item of resolved) {
          if (!item.location) continue;
          result.push({
            uid: item.uid,
            filename: item.location.filename,
            folderPath: item.location.folderPath,
          });
        }
      }

      return result;
    } catch (error) {
      this.logger?.warn("Failed to list captionless photos", {
        count: limit,
        error: errorToString(error),
      });
      return [];
    }
  }

  private async fetchLocationByUid(
    uid: string,
  ): Promise<{ filename: string; folderPath: string } | null> {
    try {
      const res = await this.http.get<PhotoDetails>(`/api/v1/photos/${uid}`);
      return this.resolveLocation(res.data);
    } catch (error) {
      this.logger?.warn("Failed to resolve photo location", {
        uid,
        error: errorToString(error),
      });
      return null;
    }
  }

  private resolveLocation(
    item: PhotoItem | PhotoDetails | null | undefined,
  ): { filename: string; folderPath: string } | null {
    if (!item) return null;

    const rawFilename =
      this.clean(item.FileName) ??
      this.clean(item.Name) ??
      this.clean(item.Files?.[0]?.FileName) ??
      this.clean(item.Files?.[0]?.Name);

    if (!rawFilename) return null;

    const normalizedFilename = rawFilename.replace(/\\/g, "/");
    const filename = path.posix.basename(normalizedFilename);
    if (!filename || filename === ".") return null;

    const fromFilenameDir = this.normalizePath(path.posix.dirname(normalizedFilename));
    const fromItemPath = this.normalizePath(
      this.clean(item.Path) ?? this.clean(item.Files?.[0]?.Path) ?? "",
    );

    const folderPath = this.mergeFolderPath(fromItemPath, fromFilenameDir);

    return { filename, folderPath };
  }

  private mergeFolderPath(fromItemPath: string, fromFilenameDir: string): string {
    if (!fromItemPath) return fromFilenameDir;
    if (!fromFilenameDir) return fromItemPath;
    if (fromItemPath === fromFilenameDir) return fromItemPath;
    if (fromItemPath.endsWith(`/${fromFilenameDir}`)) return fromItemPath;
    if (fromFilenameDir.endsWith(`/${fromItemPath}`)) return fromFilenameDir;
    return this.normalizePath(`${fromItemPath}/${fromFilenameDir}`);
  }

  private normalizePath(input: string): string {
    const normalized = input.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    return normalized === "." ? "" : normalized;
  }

  private clean(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  }
}
