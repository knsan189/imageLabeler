export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerLike {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};

const RESET_COLOR = "\x1b[0m";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatTime(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

export function errorToString(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function serializeMeta(meta: unknown): string {
  if (meta == null) return "";
  if (typeof meta === "string") return meta;
  try {
    return JSON.stringify(meta);
  } catch {
    return String(meta);
  }
}

export class Logger implements LoggerLike {
  constructor(
    private readonly scope: string,
    private readonly minLevel: LogLevel = "info",
    private readonly useColor: boolean = Boolean(
      process.stdout.isTTY && !process.env.NO_COLOR
    )
  ) {}

  child(scope: string): Logger {
    return new Logger(`${this.scope}:${scope}`, this.minLevel, this.useColor);
  }

  debug(message: string, meta?: unknown): void {
    this.print("debug", message, meta);
  }

  info(message: string, meta?: unknown): void {
    this.print("info", message, meta);
  }

  warn(message: string, meta?: unknown): void {
    this.print("warn", message, meta);
  }

  error(message: string, meta?: unknown): void {
    this.print("error", message, meta);
  }

  private print(level: LogLevel, message: string, meta?: unknown): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.minLevel]) return;

    const ts = formatTime(new Date());
    const levelText = level.toUpperCase().padEnd(5, " ");
    const base = `[${ts}] ${levelText} ${this.scope} | ${message}`;
    const metaText = serializeMeta(meta);
    const line = metaText ? `${base} ${metaText}` : base;

    if (!this.useColor) {
      this.write(level, line);
      return;
    }

    const color = LEVEL_COLOR[level];
    this.write(level, `${color}${line}${RESET_COLOR}`);
  }

  private write(level: LogLevel, line: string): void {
    if (level === "error") {
      console.error(line);
      return;
    }
    console.log(line);
  }
}
