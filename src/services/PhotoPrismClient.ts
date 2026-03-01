import axios, { AxiosInstance } from "axios";
import { sleep } from "../utils/sleep.js";
import { errorToString, LoggerLike } from "../utils/logger.js";

type WaitForUidOptions = {
  attempts?: number;
  intervalMs?: number;
};

type PhotoItem = {
  UID?: string;
};

type PhotoLabel = {
  Name?: string;
  Label?: {
    Name?: string;
  };
};

type PhotoDetails = {
  Labels?: PhotoLabel[];
  PhotoLabels?: PhotoLabel[];
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
    relDir: string,
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
    options: WaitForUidOptions = {},
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

  async addLabel(
    uid: string,
    label: string,
    priority: number = 0,
  ): Promise<void> {
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

  async updatePhoto(
    uid: string,
    description: string,
    caption: string,
  ): Promise<void> {
    try {
      await this.http.put(`/api/v1/photos/${uid}`, {
        Description: description,
        Caption: caption,
        CaptionSrc: "manual",
      });
    } catch (error) {
      this.logger?.warn("Failed to update photo", {
        uid,
        description,
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
}
