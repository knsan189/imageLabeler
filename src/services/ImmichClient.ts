import axios, { AxiosInstance } from "axios";
import { errorToString, LoggerLike } from "../utils/logger.js";

interface ImmichAsset {
  id: string;
  originalPath: string;
  originalFileName: string;
}

interface AlbumResponse {
  albumName: string;
  albumThumbnailAssetId: string;
  // albumUsers: AlbumUserResponseDto[];
  assetCount: number;
  // assets: AssetResponseDto[];
  // contributorCounts: ContributorCountResponseDto[];
  createdAt: string;
  description: string;
  endDate: string;
  hasSharedLink: boolean;
  id: string;
  isActivityEnabled: boolean;
  lastModifiedAssetTimestamp: string;
  // order: AssetOrder;
  // owner: UserResponseDto;
  ownerId: string;
  shared: boolean;
  startDate: string;
  updatedAt: string;
}

interface SearchAlbumResponse {
  count: number;
  items: AlbumResponse[];
  total: number;
  facets: [];
}

interface SearchResponse {
  albums: SearchAlbumResponse;
  assets?: SearchAssetsResponse;
}

interface SearchAssetsResponse {
  count: number;
  items: ImmichAsset[];
  facets: [];
  nextPage: string | null;
  total: number;
}

export class ImmichClient {
  private readonly http: AxiosInstance;
  private readonly logger?: LoggerLike;

  // albumName -> albumId
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

  public async listAssetsNotInAnyAlbum(
    count: number = 300,
  ): Promise<ImmichAsset[]> {
    const limit = Math.max(1, Math.floor(count));

    try {
      const res = await this.http.post<SearchResponse>("/search/metadata", {
        page: 1,
        size: limit,
        isNotInAlbum: true,
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

  public async getOrCreateAlbumId(albumName: string): Promise<string | null> {
    const name = albumName.trim();
    if (!name) return null;

    const cached = this.albumIdCache.get(name);
    if (cached) return cached;

    try {
      const res = await this.http.get<AlbumResponse[]>("/albums");
      for (const album of res.data ?? []) {
        const n = (album.albumName ?? "").trim();
        if (n) this.albumIdCache.set(n, album.id);
      }

      const found = this.albumIdCache.get(name);
      if (found) return found;

      const created = await this.http.post<AlbumResponse>("/albums", {
        albumName: name,
      });

      const id = created.data?.id;
      if (id) {
        this.albumIdCache.set(name, id);
        return id;
      }

      return null;
    } catch (error) {
      this.logger?.warn("Failed to get/create album", {
        albumName: name,
        error: errorToString(error),
      });
      return null;
    }
  }

  public async addAssetsToAlbum(
    albumId: string,
    assetIds: string[],
  ): Promise<void> {
    const id = albumId.trim();
    const ids = assetIds.map((v) => v.trim()).filter(Boolean);
    if (!id || ids.length === 0) return;

    try {
      await this.http.put(`/albums/${id}/assets`, { ids });
    } catch (error) {
      this.logger?.warn("Failed to add assets to album", {
        albumId: id,
        assetCount: ids.length,
        error: errorToString(error),
      });
    }
  }
}
