import "dotenv/config";
import { DEFAULT_CONCURRENCY, DEFAULT_MARKER_LABEL } from "./constants";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export type AppEnv = {
  originalsPath: string;
  photoPrismUrl: string;
  photoPrismToken: string;
  markerLabel: string;
  concurrency: number;
};

export const appEnv: AppEnv = {
  originalsPath: requiredEnv("ORIGINALS_PATH"),
  photoPrismUrl: requiredEnv("PHOTOPRISM_URL"),
  photoPrismToken: requiredEnv("PHOTOPRISM_TOKEN"),
  markerLabel: process.env.MARKER_LABEL?.trim() || DEFAULT_MARKER_LABEL,
  concurrency: numberEnv("CONCURRENCY", DEFAULT_CONCURRENCY),
};
