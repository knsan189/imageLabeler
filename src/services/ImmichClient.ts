import axios, { AxiosInstance } from "axios";
import { errorToString, LoggerLike } from "../utils/logger.js";
import { AlbumResponse, ImmichAsset, SearchResponse } from "./types.js";

export class ImmichClient {
  private readonly http: AxiosInstance;
  private readonly logger?: LoggerLike;

  private readonly tagIdCache = new Map<string, string>();

  private readonly albumIdCache = new Map<string, string>();

  constructor(baseUrl: string, apiKey: string, logger?: LoggerLike) {
    const trimmed = baseUrl.replace(/\/+$/, "");
    const base = trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;

    this.http = axios.create({
      baseURL: base,
      headers: {
        "x-api-key": apiKey,
      },
      timeout: 30_000,
    });

    this.logger = logger;
  }

  public async getListOfAssetsHasNoTags(
    count: number = 300,
  ): Promise<ImmichAsset[]> {
    const limit = Math.max(1, Math.floor(count));

    try {
      const res = await this.http.post<SearchResponse>("/search/metadata", {
        page: 1,
        size: limit,
        tagIds: [],
        originalPath: "/external/AI/",
        type: "IMAGE",
      });
      return res.data.assets?.items ?? [];
    } catch (error) {
      this.logger?.warn("Failed to list assets not in any album", {
        count: limit,
        error: errorToString(error),
      });
      return [];
    }
  }

  public async getOrCreateTagId(tagName: string): Promise<string | null> {
    const name = tagName.trim();
    if (!name) return null;

    const cached = this.tagIdCache.get(name);
    if (cached) return cached;

    try {
      const res =
        await this.http.get<Array<{ id: string; name: string }>>("/tags");

      for (const tag of res.data ?? []) {
        const n = (tag.name ?? "").trim();
        if (n) this.tagIdCache.set(n, tag.id);
      }

      const found = this.tagIdCache.get(name);
      if (found) return found;

      const created = await this.http.post<{ id: string }>("/tags", {
        name,
        type: "CUSTOM",
      });

      const id = created.data?.id;
      if (id) {
        this.tagIdCache.set(name, id);
        return id;
      }

      return null;
    } catch (error) {
      this.logger?.warn("Failed to get/create tag", {
        tagName: name,
        error: errorToString(error),
      });
      return null;
    }
  }

  async updateAssetDescription(
    assetId: string,
    description: string,
  ): Promise<void> {
    const id = assetId.trim();
    if (!id) return;

    try {
      await this.http.put(`/assets/${id}`, {
        description,
      });
    } catch (error) {
      this.logger?.warn("Failed to update asset description", {
        assetId: id,
        error: errorToString(error),
      });
    }
  }

  public async addAssetsToTag(
    tagId: string,
    assetIds: string[],
  ): Promise<void> {
    const id = tagId.trim();
    const ids = assetIds.map((v) => v.trim()).filter(Boolean);
    if (!id || ids.length === 0) return;

    try {
      await this.http.put(`/tags/${id}/assets`, {
        assetIds: ids,
      });
    } catch (error) {
      this.logger?.warn("Failed to add assets to tag", {
        tagId: id,
        assetCount: ids.length,
        error: errorToString(error),
      });
    }
  }

  public async listAlbums(): Promise<
    { id: string; albumName?: string; assetCount?: number }[]
  > {
    try {
      const res = await this.http.get<AlbumResponse[]>("/albums");

      return (res.data ?? []).map((a) => ({
        id: a.id,
        albumName: a.albumName,
        assetCount: a.assetCount,
      }));
    } catch (error) {
      this.logger?.warn("Failed to list albums", {
        error: errorToString(error),
      });
      return [];
    }
  }

  public async deleteAlbum(albumId: string): Promise<boolean> {
    const id = albumId.trim();
    if (!id) return false;

    try {
      await this.http.delete(`/albums/${id}`);

      // 캐시 정리
      for (const [name, cachedId] of this.albumIdCache.entries()) {
        if (cachedId === id) {
          this.albumIdCache.delete(name);
        }
      }

      return true;
    } catch (error) {
      this.logger?.warn("Failed to delete album", {
        albumId: id,
        error: errorToString(error),
      });
      return false;
    }
  }
}
