import axios, { AxiosInstance } from "axios";
import { sleep } from "../utils/sleep";

type WaitForUidOptions = {
  attempts?: number;
  intervalMs?: number;
};

type PhotoItem = {
  UID?: string;
};

type FileItem = { PhotoUID?: string; UID?: string; FileName?: string; Path?: string };

export class PhotoPrismClient {
  private readonly http: AxiosInstance;

  constructor(baseUrl: string, token: string) {
    this.http = axios.create({
      baseURL: baseUrl.replace(/\/+$/, ""),
      headers: {
        Authorization: `Bearer ${token}`,
      },
      timeout: 30_000,
    });
  }

  async findPhotoUidByFilename(filename: string, relDir: string): Promise<string | null> {
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
      console.error("Error finding photo UID by filename:", error);
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
      console.log("UID response:", uid);
      if (uid) return uid;
      await sleep(intervalMs);
    }

    return null;
  }

  async addLabel(uid: string, label: string): Promise<void> {
    try {
    await this.http.post(`/api/v1/photos/${uid}/label`, {
      Name: label,
        Priority: 0,
        Uncertainty: 0,
      });
    } catch (error) {
      console.error("Error adding label:", error);
    }
  }
}
