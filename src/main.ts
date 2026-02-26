import "dotenv/config";
import { NextcloudSystemTagger } from "./NextcloudSystemTagger";
import { NextcloudFolderWatcher } from "./NextcloudFolderWatcher";

const BASE = (process.env.NC_DAV_BASE || "").replace(/\/+$/, "");
const USER = process.env.NC_USERNAME || "";
const PASS = process.env.NC_PASSWORD || "";
const REMOTE_BASE = (process.env.NC_REMOTE_BASE || "photos/2025").replace(
  /^\/+|\/+$/g,
  ""
);

async function main() {
  const tagger = new NextcloudSystemTagger(BASE, USER, PASS, {
    tagLimit: Number(process.env.TAG_LIMIT || 10),
  });

  const watcher = new NextcloudFolderWatcher(
    BASE,
    USER,
    PASS,
    REMOTE_BASE,
    tagger,
    {
      pollMs: Number(process.env.POLL_MS || 8000),
      stateFile: process.env.STATE_FILE || ".nc_watcher_state.json",
      dryRun: String(process.env.DRY_RUN || "false").toLowerCase() === "true",
    }
  );

  await watcher.start();

  // 종료 신호 처리
  process.on("SIGINT", () => {
    watcher.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    watcher.stop();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
