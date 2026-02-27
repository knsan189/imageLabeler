import { execFile } from "child_process";
import { promisify } from "util";
import { errorToString, LoggerLike } from "./logger.js";

const execFileAsync = promisify(execFile);

type ExtractPromptOptions = {
  logger?: LoggerLike;
};

export async function extractPrompt(
  filePath: string,
  options: ExtractPromptOptions = {}
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("exiftool", [
      "-s3",
      "-Parameters",
      "-UserComment",
      "-Comment",
      "-XMP:Description",
      filePath,
    ]);

    const text = stdout.toString().trim();
    return text.length > 0 ? text : null;
  } catch (error) {
    options.logger?.warn("Exiftool prompt extraction failed", {
      filePath,
      error: errorToString(error),
    });
    return null;
  }
}
