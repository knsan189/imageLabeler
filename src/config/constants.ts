export const DEFAULT_MARKER_LABEL = "pp:prompt_imported";
export const DEFAULT_CONCURRENCY = 5;

export const WATCHER_OPTIONS = {
  ignoreInitial: false,
  awaitWriteFinish: {
    stabilityThreshold: 3000,
    pollInterval: 200,
  },
} as const;

export const WATCHED_IMAGE_FILE_RE = /\.(png|webp|jpg|jpeg)$/i;

export const PHOTO_UID_LOOKUP_ATTEMPTS = 20;
export const PHOTO_UID_LOOKUP_INTERVAL_MS = 3_000;
