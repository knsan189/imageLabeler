/* eslint-disable @typescript-eslint/no-explicit-any */
import axios, { AxiosInstance } from "axios";
import fs from "fs";
import { NextcloudSystemTagger } from "./NextcloudSystemTagger";

export type WatcherOptions = {
  pollMs?: number;
  stateFile?: string;
  dryRun?: boolean;
};

type Seen = Record<string, { etag: string | null; ts: number }>;

export class NextcloudFolderWatcher {
  private base: string;
  private user: string;
  private http: AxiosInstance;
  private tagger: NextcloudSystemTagger;
  private remoteBase: string;
  private pollMs: number;
  private stateFile: string;
  private dry: boolean;
  private timer: NodeJS.Timeout | null = null;
  private seen: Seen = {};

  constructor(
    baseDavUrl: string,
    username: string,
    password: string,
    remoteBase: string,
    tagger: NextcloudSystemTagger,
    opts?: WatcherOptions
  ) {
    this.base = baseDavUrl.replace(/\/+$/, "");
    this.user = username;
    this.remoteBase = remoteBase.replace(/^\/+|\/+$/g, "");
    this.tagger = tagger;

    this.pollMs = opts?.pollMs ?? 8000;
    this.stateFile = opts?.stateFile ?? ".nc_watcher_state.json";
    this.dry = !!opts?.dryRun;

    this.http = axios.create({
      baseURL: this.base,
      auth: { username, password },
      headers: { "OCS-APIREQUEST": "true" },
      timeout: 30000,
      validateStatus: (s) => s >= 200 && s < 500,
    });

    this.seen = this.loadSeen();
  }

  async start(): Promise<void> {
    console.log(
      `🚀 PROPFIND watcher 시작: /files/${this.user}/${this.remoteBase} (poll=${this.pollMs}ms, dry=${this.dry})`
    );
    await this.tick(); // 첫 실행
    this.timer = setInterval(() => this.tick().catch(() => {}), this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    console.log("🛑 watcher 중지");
  }

  // ---------------- internals ----------------

  private loadSeen(): Seen {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
    } catch {
      return {};
    }
  }
  private saveSeen(): void {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(this.seen, null, 2));
    } catch {}
  }

  private collectionPath(rel: string): string {
    const parts = rel
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter(Boolean);
    const encoded = parts.map(encodeURIComponent).join("/");

    // ✅ remote.php/dav 포함하지 않음
    let href = `/files/${this.user}/${encoded}`;
    if (!href.endsWith("/")) href += "/";
    return href;
  }
  private async tick(): Promise<void> {
    try {
      const root = this.collectionPath(this.remoteBase);
      const found: Array<{
        path: string;
        etag: string | null;
        isDir: boolean;
      }> = [];
      await this.walk(root, found);

      // 파일만 추려서 PNG + 변경감지 → 태깅
      const files = found.filter(
        (f) => !f.isDir && f.path.toLowerCase().endsWith(".png")
      );
      for (const it of files) {
        const prev = this.seen[it.path];
        if (prev && prev.etag === it.etag) continue; // 변경 없음
        console.log(`🔔 변경 감지: ${it.path} (etag=${it.etag})`);

        if (!this.dry) {
          const remotePath = it.path; // Files 기준 경로
          await this.tagger.tagPositivePrompt(remotePath);
        } else {
          console.log(`(dry) 태그 시뮬레이션: ${it.path}`);
        }

        this.seen[it.path] = { etag: it.etag, ts: Date.now() };
      }

      this.saveSeen();
    } catch (e: any) {
      console.warn("⚠️ tick 오류:", e?.message || e);
    }
  }

  // ----- PROPFIND 재귀 -----

  private async walk(
    collectionHref: string,
    out: Array<{ path: string; etag: string | null; isDir: boolean }>
  ): Promise<void> {
    // collectionHref는 반드시 '/files/<user>/.../' 형태여야 함
    const xml = await this.propfind(collectionHref, 1);
    const entries = this.parsePropfind(xml);

    for (const e of entries) {
      if (!e.href) continue;

      // ★ 여기서 <d:href>를 DAV 상대 경로로 변환
      const davUrl = this.hrefToDavUrl(e.href);

      // 자기 자신 응답은 스킵
      if (
        davUrl === collectionHref ||
        davUrl === collectionHref.replace(/\/+$/, "")
      )
        continue;

      const isDir = /<d:collection\/>/.test(e.props);

      // 태그용 remotePath는 Files 루트 기준 경로 (예: 'temp/a.png')
      const remotePath = this.stripFilesRoot(davUrl);

      out.push({ path: remotePath, etag: e.etag, isDir });

      if (isDir) {
        const child = davUrl.endsWith("/") ? davUrl : davUrl + "/";
        await this.walk(child, out); // ★ davUrl은 이미 '/files/...' 로 정규화됨
      }
    }
  }
  private async propfind(url: string, depth: 0 | 1): Promise<string> {
    const full = this.base.replace(/\/+$/, "") + url; // 로그만 찍음
    console.log(`[DEBUG] PROPFIND → ${full} (Depth=${depth})`);

    const res = await this.http.request({
      url, // url은 /files/... 로 시작
      method: "PROPFIND",
      headers: {
        Depth: String(depth),
        "Content-Type": "application/xml; charset=utf-8",
        Accept: "application/xml, text/xml, */*;q=0.1",
      },
      data:
        `<?xml version="1.0" encoding="utf-8"?>` +
        `<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">` +
        `<d:prop><d:getetag/><d:resourcetype/><oc:fileid/></d:prop>` +
        `</d:propfind>`,
      transformRequest: [(d) => d],
    });

    if (res.status >= 400)
      throw new Error(`PROPFIND ${res.status} ${res.statusText}`);
    return typeof res.data === "string" ? res.data : String(res.data);
  }

  private parsePropfind(
    xml: string
  ): Array<{ href: string; etag: string | null; props: string }> {
    const parts = xml.split("<d:response").slice(1);
    const out: Array<{ href: string; etag: string | null; props: string }> = [];
    for (const p of parts) {
      const href = this.match1(p, /<d:href>(.*?)<\/d:href>/i);
      const etag = this.match1(p, /<d:getetag>(.*?)<\/d:getetag>/i);
      const propstat =
        this.match1(
          p,
          /<d:propstat>[\s\S]*?<d:prop>([\s\S]*?)<\/d:prop>[\s\S]*?<\/d:propstat>/i
        ) || "";
      if (!href) continue;
      out.push({
        href: this.decodeXml(href),
        etag: etag ? this.decodeXml(etag) : null,
        props: propstat,
      });
    }
    return out;
  }

  private stripFilesRoot(href: string): string {
    const prefix = `/files/${this.user}/`;
    const dec = this.decodeXml(href);
    return decodeURIComponent(
      dec.startsWith(prefix) ? dec.slice(prefix.length) : dec
    );
  }

  private match1(s: string, re: RegExp): string | null {
    const m = s.match(re);
    return m ? m[1] : null;
  }
  private decodeXml(s = ""): string {
    return s
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&")
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'");
  }

  private hrefToDavUrl(href: string): string {
    // XML 엔티티 해제
    let dec = this.decodeXml(href);

    // 호스트가 포함돼 오면 path만 추출 (안 들어오는 경우가 대부분)
    const u = dec.startsWith("http") ? new URL(dec) : null;
    if (u) dec = u.pathname;

    // /remote.php/dav 앞부분을 제거해서 DAV root-relative 로 만든다
    dec = dec.replace(/^.*?\/remote\.php\/dav/, "");

    // 항상 슬래시로 시작
    if (!dec.startsWith("/")) dec = "/" + dec;

    // 디렉토리면 슬래시 보장
    if (!dec.endsWith("/")) {
      // 끝이 파일/디렉토리 여부는 resourcetype으로 판단하지만
      // 상위 walk에서 디렉토리일 때는 추가로 '/' 붙여줍니다.
    }
    return dec;
  }
}
