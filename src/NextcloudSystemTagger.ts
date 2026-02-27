import axios, { AxiosInstance } from "axios";
import { extractPngInfo, PngInfo } from "./PngInfo.js";

export type TaggerOptions = {
  tagLimit?: number;
  stopwords?: string[];
  dryRun?: boolean;
  logLevel?: "silent" | "info" | "debug";
  previewLen?: number;
};

export class NextcloudSystemTagger {
  private http: AxiosInstance;
  private ocs: AxiosInstance;
  private serverBase: string;
  private base: string;
  private username: string;
  private tagLimit: number;
  private stopwords: Set<string>;
  private dryRun: boolean;
  private logLevel: "silent" | "info" | "debug";
  private previewLen: number;

  constructor(
    baseDavUrl: string, // 예: https://cloud.example.com/remote.php/dav
    username: string,
    password: string,
    opts?: TaggerOptions
  ) {
    this.base = baseDavUrl.replace(/\/+$/, "");
    this.username = username;
    this.tagLimit = opts?.tagLimit ?? 10;
    this.stopwords = new Set(
      (
        opts?.stopwords ?? [
          "a",
          "an",
          "the",
          "of",
          "and",
          "with",
          "in",
          "on",
          "to",
          "is",
        ]
      ).map((w) => w.toLowerCase())
    );
    this.dryRun = !!opts?.dryRun;
    this.logLevel = opts?.logLevel ?? "info";
    this.previewLen = opts?.previewLen ?? 140;

    // Derive server root base (strip /remote.php/dav from baseDavUrl)
    const m = this.base.match(
      /^(https?:\/\/[^/]+)(?:\/remote\.php\/dav\/?$)?/i
    );
    this.serverBase = m
      ? m[1]
      : this.base.replace(/\/remote\.php\/dav\/?$/i, "");

    // OCS client must be rooted at server origin, not /remote.php/dav
    this.ocs = axios.create({
      baseURL: this.serverBase,
      auth: { username, password },
      headers: { "OCS-APIREQUEST": "true" },
      timeout: 30000,
      validateStatus: (s) => s >= 200 && s < 500,
    });

    this.http = axios.create({
      baseURL: this.base,
      auth: { username, password },
      headers: { "OCS-APIREQUEST": "true" },
      timeout: 30000,
      validateStatus: (s) => s >= 200 && s < 500,
    });
  }

  /** remotePath: Files 루트 기준 (예: "photos/2025/a.png") */
  async tagPositivePrompt(remotePath: string): Promise<void> {
    if (!remotePath.toLowerCase().endsWith(".png")) {
      this.debug(`[Tagger] skip(non-png): ${remotePath}`);
      return;
    }

    this.info(`📸 [Tagger] Processing: ${remotePath}`);

    const buf = await this.downloadRemote(remotePath);
    if (!buf) {
      this.info(`⚠️  [Tagger] download failed → ${remotePath}`);
      return;
    }

    // 🔽 PNG Info 방식으로 추출 (WebUI PNG Info와 동일한 형식)
    const info = extractPngInfo(buf);
    if (!info?.positive) {
      this.info(`⚠️  [Tagger] no positive prompt → ${remotePath}`);
      return;
    }

    this.debug(
      `🧠 [Tagger] Positive preview: ${this.ellipsize(
        info.positive,
        this.previewLen
      )}`
    );
    if (info.negative)
      this.debug(
        `🙅 [Tagger] Negative preview: ${this.ellipsize(
          info.negative,
          this.previewLen
        )}`
      );

    const tags = this.promptToTags(info.positive);
    if (!tags.length) {
      this.info(`⚠️  [Tagger] no tags extracted → ${remotePath}`);
      return;
    }
    this.info(`🏷️  [Tagger] Tags: ${JSON.stringify(tags)}`);

    const fileId = await this.getFileId(remotePath);
    if (!fileId) {
      this.info(`⚠️  [Tagger] cannot resolve fileId → ${remotePath}`);
      return;
    }
    this.debug(`🔎 [Tagger] fileId(${remotePath}) = ${fileId}`);

    for (const t of tags) {
      try {
        const tagId = await this.getOrCreatePersonalTagId(t);
        await this.attachPersonalTag(fileId, tagId);
        this.info(`✅ [Tagger] attached (personal): "${t}" → fileId=${fileId}`);
      } catch (e: any) {
        this.info(
          `⚠️  [Tagger] tag attach failed ("${t}") → ${e?.message || e}`
        );
      }
    }

    this.info(`✨ [Tagger] done: ${remotePath}`);
  }

  // ---------- internals ----------

  private async downloadRemote(remotePath: string): Promise<Buffer | null> {
    const url = this.filesRoot(remotePath);
    this.debug(`GET ${this.base}${url}`);
    const res = await this.http.get(url, { responseType: "arraybuffer" });
    this.debug(`→ ${res.status} ${res.statusText}`);
    if (res.status >= 200 && res.status < 300) return Buffer.from(res.data);
    this.info(`[Tagger] 다운로드 실패: ${remotePath} (status ${res.status})`);
    return null;
  }

  public async getPngInfo(remotePath: string): Promise<PngInfo | null> {
    if (!remotePath.toLowerCase().endsWith(".png")) return null;
    const buf = await this.downloadRemote(remotePath);
    if (!buf) return null;
    const info = extractPngInfo(buf);
    return info;
  }

  public async printPngInfo(remotePath: string): Promise<void> {
    const info = await this.getPngInfo(remotePath);
    if (!info) {
      console.log(`❌ PNG info not found: ${remotePath}`);
      return;
    }
    console.log(`\n🧾 PNG Info — ${remotePath}`);
    if (info.positive) console.log(`Positive: ${info.positive}`);
    if (info.negative) console.log(`Negative: ${info.negative}`);
    if (info.steps != null) console.log(`Steps: ${info.steps}`);
    if (info.sampler) console.log(`Sampler: ${info.sampler}`);
    if (info.cfg != null) console.log(`CFG: ${info.cfg}`);
    if (info.seed != null) console.log(`Seed: ${info.seed}`);
    if (info.size) console.log(`Size: ${info.size.width}x${info.size.height}`);
    if (info.model) console.log(`Model: ${info.model}`);
    // 필요하면 info.raw로 원시 텍스트 키/값도 모두 출력 가능
    console.log(""); // 한 줄 띄움
  }

  private promptToTags(prompt: string): string[] {
    const raw = String(prompt)
      .split(",")
      .map((s) => s.trim().toLowerCase().replace(/\s+/g, " "))
      .filter(Boolean)
      .filter((s) => s.length >= 2 && !this.stopwords.has(s));
    return Array.from(new Set(raw)).slice(0, this.tagLimit);
  }

  // Removed system tag helper methods: findTagIdByName, getOrCreateTagId, attachTag

  // NextcloudSystemTagger.ts 안의 getFileId를 이 버전으로 교체
  private async getFileId(remotePath: string): Promise<string | null> {
    const url = this.filesRoot(remotePath);

    const body =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">` +
      `  <d:prop>` +
      `    <oc:fileid/>` +
      `    <d:getetag/>` +
      `    <d:resourcetype/>` +
      `  </d:prop>` +
      `</d:propfind>`;

    const res = await this.http.request({
      url,
      method: "PROPFIND",
      data: body,
      headers: {
        Depth: "0",
        "Content-Type": "application/xml; charset=utf-8",
        Accept: "application/xml, text/xml, */*;q=0.1",
      },
    });

    this.debug(`→ getFileId PROPFIND status ${res.status}`);
    if (res.status >= 200 && res.status < 300) {
      const xml: string =
        typeof res.data === "string" ? res.data : String(res.data);
      const m = xml.match(/<oc:fileid>(\d+)<\/oc:fileid>/i);
      if (m) return m[1] || null;
    }

    // 폴백: OCS API 시도
    return await this.getFileIdViaOcs(remotePath);
  }

  // NextcloudSystemTagger.ts 내부에 추가
  private async getFileIdViaOcs(remotePath: string): Promise<string | null> {
    // OCS는 경로 기준으로 id 조회 가능
    const rel = remotePath.replace(/^\/+/, "");
    this.debug(`OCS files lookup path=/${rel}`);
    const res = await this.ocs.get(`/ocs/v2.php/apps/files/api/v1/files`, {
      params: { format: "json", path: `/${rel}` },
      headers: { Accept: "application/json", "OCS-APIREQUEST": "true" },
      validateStatus: (s) => s >= 200 && s < 500,
    });
    this.debug(`→ OCS files id status ${res.status}`);
    try {
      const id = String(res.data?.ocs?.data?.id ?? "");
      return id || null;
    } catch {
      return null;
    }
  }

  private filesRoot(relPath: string): string {
    const clean = relPath.replace(/^\/+/, "");
    const encoded = clean.split("/").map(encodeURIComponent).join("/");
    return `/files/${this.username}/${encoded}`;
  }

  private escapeXml(str: string): string {
    return str
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  }

  // ---------- Personal (user) tags via OCS API ----------
  private async listPersonalTags(): Promise<
    Array<{ id: string; name: string }>
  > {
    const res = await this.ocs.get(`/ocs/v2.php/apps/files/api/v1/tags`, {
      params: { format: "json" },
      headers: { Accept: "application/json", "OCS-APIREQUEST": "true" },
      validateStatus: (s) => s >= 200 && s < 500,
    });
    this.debug(`→ OCS list tags status ${res.status}`);
    const data = res.data?.ocs?.data;
    if (!data) {
      const preview =
        typeof res.data === "string"
          ? res.data.slice(0, 200)
          : JSON.stringify(res.data)?.slice(0, 200);
      this.debug(`OCS list tags empty; preview: ${preview}`);
      return [];
    }
    // data can be an array or an object; normalize to array of {id,name}
    const arr = Array.isArray(data) ? data : data?.tags || [];
    return arr
      .map((x: any) => ({
        id: String(x?.id ?? x?.tagid ?? ""),
        name: String(x?.name ?? x?.displayname ?? ""),
      }))
      .filter((x: any) => x.id && x.name);
  }

  private async findPersonalTagIdByName(name: string): Promise<string | null> {
    const tags = await this.listPersonalTags();
    const found = tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
    return found ? found.id : null;
  }

  private async createPersonalTag(name: string): Promise<string | null> {
    const body = new URLSearchParams({ name }).toString();
    const res = await this.ocs.post(
      `/ocs/v2.php/apps/files/api/v1/tags`,
      body,
      {
        params: { format: "json" }, // ← ensure JSON response from OCS
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
          Accept: "application/json",
          "OCS-APIREQUEST": "true",
        },
        validateStatus: (s) => s >= 200 && s < 500,
      }
    );
    this.debug(`→ OCS create tag status ${res.status}`);

    // Some servers return data in different shapes; try several keys
    let id = "";
    try {
      const d = res.data?.ocs?.data;
      id = String(d?.id ?? d?.tagid ?? d?.["id"] ?? "").trim();
    } catch {}

    if (!id) {
      // dump a short preview for troubleshooting
      const preview =
        typeof res.data === "string"
          ? res.data.slice(0, 400)
          : JSON.stringify(res.data)?.slice(0, 400);
      this.debug(`OCS create tag response preview: ${preview}`);
    }

    return id || null;
  }

  private async getOrCreatePersonalTagId(name: string): Promise<string> {
    const existed = await this.findPersonalTagIdByName(name);
    if (existed) {
      this.debug(`↩︎  personal tag exists "${name}" → id=${existed}`);
      return existed;
    }
    const created = await this.createPersonalTag(name);
    if (created) return created;
    // last resort re-list
    const retry = await this.findPersonalTagIdByName(name);
    if (retry) return retry;
    throw new Error("Failed to create/find personal tag: " + name);
  }

  private async attachPersonalTag(
    fileId: string,
    tagId: string
  ): Promise<void> {
    fileId = String(fileId);
    tagId = String(tagId);
    const url = `/ocs/v2.php/apps/files/api/v1/files/${fileId}/tags/${tagId}`;

    this.debug(`PUT ${url} (attempt #1)`);
    let res = await this.ocs.put(url, "", {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": "0",
        Accept: "application/json",
        "OCS-APIREQUEST": "true",
      },
      validateStatus: (s) =>
        s === 200 || s === 201 || s === 204 || s === 409 || s === 415,
    });

    // 409: already tagged, treat as success; 415: retry without body/ctype
    if (res.status === 415) {
      this.debug(
        `PUT ${url} returned 415 — retrying without body & Content-Type`
      );
      res = await this.ocs.request({
        url,
        method: "PUT",
        data: undefined,
        headers: { Accept: "application/json", "OCS-APIREQUEST": "true" },
        transformRequest: [
          function (data, headers) {
            if (headers) {
              delete (headers as any)["Content-Type"];
              delete (headers as any)["content-type"];
            }
            return data;
          },
        ],
        validateStatus: (s) => s === 200 || s === 201 || s === 204 || s === 409,
      });
    }

    this.debug(`→ attachPersonalTag status ${res.status}`);
    if (
      !(
        res.status === 200 ||
        res.status === 201 ||
        res.status === 204 ||
        res.status === 409
      )
    ) {
      throw new Error(`attachPersonalTag failed: ${res.status}`);
    }
  }

  // ---------- logging helpers ----------
  private info(msg: string) {
    if (this.logLevel === "silent") return;
    console.log(msg);
  }
  private debug(msg: string) {
    if (this.logLevel !== "debug") return;
    console.log(msg);
  }
  private ellipsize(s: string, n: number) {
    return s.length > n ? s.slice(0, n) + "…" : s;
  }
}
