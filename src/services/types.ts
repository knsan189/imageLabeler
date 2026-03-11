export interface ImmichAsset {
  id: string;
  originalPath: string;
  originalFileName: string;
}

export interface AlbumResponse {
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

export interface SearchAlbumResponse {
  count: number;
  items: AlbumResponse[];
  total: number;
  facets: [];
}

export interface SearchResponse {
  albums: SearchAlbumResponse;
  assets?: SearchAssetsResponse;
}

export interface SearchAssetsResponse {
  count: number;
  items: ImmichAsset[];
  facets: [];
  nextPage: string | null;
  total: number;
}
