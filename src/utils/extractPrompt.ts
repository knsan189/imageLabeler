import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export async function extractPrompt(filePath: string): Promise<string | null> {
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
    console.error("Exiftool error:", error);
    return null;
  }
}
