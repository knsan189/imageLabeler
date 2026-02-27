import "dotenv/config";
import { DEFAULT_CONCURRENCY, DEFAULT_MARKER_LABEL } from "./constants.js";
import { LogLevel } from "../utils/logger.js";

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

function logLevelEnv(name: string, fallback: LogLevel): LogLevel {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return fallback;
}

export type AppEnv = {
  originalsPath: string;
  photoPrismUrl: string;
  photoPrismToken: string;
  markerLabel: string;
  concurrency: number;
  logLevel: LogLevel;
};

export const appEnv: AppEnv = {
  originalsPath: requiredEnv("ORIGINALS_PATH"),
  photoPrismUrl: requiredEnv("PHOTOPRISM_URL"),
  photoPrismToken: requiredEnv("PHOTOPRISM_TOKEN"),
  markerLabel: process.env.MARKER_LABEL?.trim() || DEFAULT_MARKER_LABEL,
  concurrency: numberEnv("CONCURRENCY", DEFAULT_CONCURRENCY),
  logLevel: logLevelEnv("LOG_LEVEL", "info"),
};
