import { PNG } from "pngjs";
import extractChunks from "png-chunks-extract";
import zlib from "zlib";

export type PngInfo = {
  positive?: string;
  negative?: string;
  steps?: number;
  sampler?: string;
  cfg?: number;
  seed?: string | number;
  size?: { width: number; height: number };
  model?: string;
  raw?: Record<string, string>; // 키 → 원문 텍스트(모든 청크)
};

export function extractPngInfo(buf: Buffer): PngInfo | null {
  // 0) pngjs text 먼저 확인
  try {
    const png = PNG.sync.read(buf);
    const textMap: Record<string, string> = (png as any)?.text || {};
    if (textMap && Object.keys(textMap).length) {
      const info = pickFromTextMap(textMap);
      if (info) return info;
    }
  } catch {
    // 무시 후 청크 파싱 시도
  }

  // 1) 모든 텍스트 청크 수집
  const map = parseAllPngTextChunks(buf);
  if (!Object.keys(map).length) return null;

  const info = pickFromTextMap(map);
  if (info) return info;

  // 마지막 방어: map 전체에서 A1111 스타일 탐색
  return parseFromFreeForm(Object.values(map).join("\n"), map);
}

function parseAllPngTextChunks(buf: Buffer): Record<string, string> {
  const chunks = extractChunks(buf) as Array<{
    name: string;
    data: Uint8Array;
  }>;
  const out: Record<string, string[]> = {};

  for (const ch of chunks) {
    if (ch.name === "tEXt") {
      // keyword\0text (둘 다 Buffer로 디코딩!)
      const i = ch.data.indexOf(0x00);
      if (i > 0) {
        const keyword = Buffer.from(ch.data.subarray(0, i)).toString("latin1");
        const text = Buffer.from(ch.data.subarray(i + 1)).toString("latin1");
        (out[keyword] ||= []).push(text);
      }
    } else if (ch.name === "zTXt") {
      // keyword\0method(1B) + compressedText
      const i = ch.data.indexOf(0x00);
      if (i > 0 && ch.data.length > i + 2) {
        const keyword = Buffer.from(ch.data.subarray(0, i)).toString("latin1");
        const method = ch.data[i + 1]; // 0=deflate
        const compUA = ch.data.subarray(i + 2);
        try {
          const comp = Buffer.from(compUA);
          const textBuf = method === 0 ? zlib.inflateSync(comp) : comp;
          const text = textBuf.toString("utf8");
          (out[keyword] ||= []).push(text);
        } catch {
          /* ignore */
        }
      }
    } else if (ch.name === "iTXt") {
      // keyword\0compressionFlag\0compressionMethod\0languageTag\0translatedKeyword\0text
      let off = 0;
      const dataBuf = Buffer.from(ch.data);

      const readNT = (enc: BufferEncoding) => {
        const z = dataBuf.indexOf(0x00, off);
        const s = (
          z >= 0 ? dataBuf.subarray(off, z) : dataBuf.subarray(off)
        ).toString(enc);
        off = z >= 0 ? z + 1 : dataBuf.length;
        return s;
      };

      const keyword = readNT("latin1");
      if (off >= dataBuf.length) continue;
      const compFlag = dataBuf[off];
      off += 1;
      const compMethod = dataBuf[off];
      off += 1; // 0=deflate
      const _lang = readNT("ascii");
      const _translated = readNT("utf8");
      const textBytes = dataBuf.subarray(off);

      try {
        const textBuf = compFlag
          ? compMethod === 0
            ? zlib.inflateSync(textBytes)
            : textBytes
          : textBytes;
        const text = Buffer.from(textBuf).toString("utf8");
        (out[keyword] ||= []).push(text);
      } catch {
        /* ignore */
      }
    }
  }

  const flat: Record<string, string> = {};
  for (const [k, arr] of Object.entries(out)) flat[k] = arr.join("\n");
  return flat;
}

// PngInfo.ts
function pickFromTextMap(textMap: Record<string, string>): PngInfo | null {
  // 키를 소문자로 평탄화
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(textMap))
    lower[k.toLowerCase()] = String(v ?? "");

  // 1) A1111 standard: 'parameters' (대소문자/변형 포함)
  const paramKey = Object.keys(lower).find((k) => k === "parameters");
  if (paramKey) {
    return parseA1111ParametersBlock(lower[paramKey], textMap);
  }

  // 2) 흔한 변형 키: description / comment / pnginfo / software 등
  for (const k of ["description", "comment", "pnginfo", "software"]) {
    if (lower[k]) {
      const info = parseA1111ParametersBlock(lower[k], textMap, true /*loose*/);
      if (info) return info;
    }
  }

  // 3) JSON 후보
  for (const v of Object.values(lower)) {
    if (/^\s*[\{\[]/.test(v)) {
      try {
        const obj = JSON.parse(v);
        const info = parseFromJson(obj, textMap);
        if (info) return info;
      } catch {
        /* ignore */
      }
    }
  }

  // 4) 자유 텍스트: 어디든 'Negative prompt:' 보이면 그 앞을 Positive로
  const withNeg = Object.values(lower).find((s) => /Negative prompt:/i.test(s));
  if (withNeg) return parseFromFreeForm(withNeg, textMap);

  // 5) 전체 합쳐서 마지막 시도
  return parseFromFreeForm(Object.values(lower).join("\n"), textMap);
}

/** A1111 parameters 블록 파서 */
export function parseA1111ParametersBlock(
  raw: string,
  all?: Record<string, string>,
  loose = false
): PngInfo | null {
  // 기본 형태:
  // <positive...>
  // Negative prompt: <negative...>
  // Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 123, Size: 512x512, Model: foo, ...
  const posNegSplit = raw.split(/[\r\n]+Negative prompt:\s*/i);
  let positive = posNegSplit[0]?.trim();
  let negative: string | undefined;
  let tail = "";

  if (posNegSplit.length > 1) {
    // negative + tail
    // tail은 보통 다음 줄부터 헤더들
    const negAndTail = posNegSplit[1];
    const m = negAndTail.match(/([\s\S]*?)(?:[\r\n]+(.+)|$)/);
    negative = m?.[1]?.trim() || undefined;
    tail = (m?.[2] || "").trim();
  } else if (loose) {
    // 느슨 모드: 헤더 라인을 찾아 그 이전을 positive로 추정
    const HEADER_RE =
      /(?:^|\n)\s*(Steps|Sampler|CFG|CFG scale|Seed|Size|Model|Hires|Denoising|Clip|ENSD)\s*:/i;
    const idx = raw.search(HEADER_RE);
    if (idx > 0) {
      // 헤더 전까지 positive
      const part = raw.slice(0, idx);
      tail = raw.slice(idx);
      // 가끔 "Positive prompt:" 라벨이 있는 경우
      const mp = part.match(/Positive\s*prompt:\s*([\s\S]*)/i);
      const best = (mp?.[1] || part).trim();
      if (best) {
        positive = best;
        negative = undefined;
        // normalize weights
        positive = removeWeights(positive);
        if (negative) negative = removeWeights(negative);
        return {
          positive,
          ...parseHeaderLine(tail),
          raw: all || { parameters: raw },
        };
      }
    }
  }

  // 헤더 라인 찾기 (보통 마지막 줄)
  // 쉼표로 이어진 K: V 페어들
  const headerLine = tail || raw.split(/\r?\n/).slice(-1)[0] || "";
  const meta = parseHeaderLine(headerLine);

  // normalize weights
  if (positive) positive = removeWeights(positive);
  if (negative) negative = removeWeights(negative);

  const info: PngInfo = {
    positive: (positive || "").trim() || undefined,
    negative: (negative || "").trim() || undefined,
    ...meta,
    raw: all || { parameters: raw },
  };

  // 최소 positive 없으면 무효
  if (!info.positive) return null;
  return info;
}

/** "Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 123, Size: 512x512, Model: foo" 파싱 */
function parseHeaderLine(line: string): Partial<PngInfo> {
  const meta: Partial<PngInfo> = {};
  const parts = line.split(/\s*,\s*/).filter(Boolean);
  for (const p of parts) {
    const [kRaw, ...rest] = p.split(/\s*:\s*/);
    const k = (kRaw || "").toLowerCase();
    const v = rest.join(":").trim();
    if (!k || !v) continue;

    if (k.startsWith("steps")) {
      const n = Number(v.replace(/[^\d.]/g, ""));
      if (!Number.isNaN(n)) meta.steps = n;
    } else if (k.startsWith("sampler")) {
      meta.sampler = v;
    } else if (k.startsWith("cfg")) {
      const n = Number(v.replace(/[^\d.]/g, ""));
      if (!Number.isNaN(n)) meta.cfg = n;
    } else if (k.startsWith("seed")) {
      const num = Number(v);
      meta.seed = Number.isNaN(num) ? v : num;
    } else if (k.startsWith("size")) {
      const m = v.match(/(\d+)\s*x\s*(\d+)/i);
      if (m) meta.size = { width: Number(m[1]), height: Number(m[2]) };
    } else if (k.startsWith("model")) {
      meta.model = v;
    }
  }
  return meta;
}

/** Comfy/NovelAI 류 JSON에서 공통 키 추출 */
function parseFromJson(obj: any, raw?: Record<string, string>): PngInfo | null {
  const info: PngInfo = { raw };
  const pos =
    obj?.prompt ??
    obj?.positive ??
    obj?.caption ??
    obj?.text ??
    obj?.Prompt ??
    null;

  const neg = obj?.negative_prompt ?? obj?.negative ?? obj?.uc ?? null;

  if (typeof pos === "string") info.positive = pos.trim();
  if (typeof neg === "string") info.negative = neg.trim();

  // 흔한 필드
  if (typeof obj?.steps === "number") info.steps = obj.steps;
  if (typeof obj?.sampler === "string") info.sampler = obj.sampler;
  if (typeof obj?.cfg_scale === "number") info.cfg = obj.cfg_scale;
  if (obj?.seed != null) info.seed = obj.seed;
  if (typeof obj?.model === "string") info.model = obj.model;
  if (obj?.width && obj?.height)
    info.size = { width: Number(obj.width), height: Number(obj.height) };

  if (info.positive) return info;
  return null;
}

/** 자유 텍스트에서 A1111 스타일 추정 파싱 */
function parseFromFreeForm(
  s: string,
  raw?: Record<string, string>
): PngInfo | null {
  const NEG = /Negative prompt:\s*/i;
  const hasNeg = NEG.test(s);
  let positive: string | undefined;
  let negative: string | undefined;
  let tail = "";

  if (hasNeg) {
    const [posPart, after] = s.split(NEG);
    positive = (posPart || "").trim() || undefined;
    // after에서 첫 줄을 negative로, 나머지에서 헤더를 찾는다
    const m = after.match(/([\s\S]*?)(?:[\r\n]+(.+)|$)/);
    negative = m?.[1]?.trim() || undefined;
    tail = (m?.[2] || "").trim();
  } else {
    // 헤더 라인 전까지를 positive로 추정
    const HEADER_RE =
      /(?:^|\n)\s*(Steps|Sampler|CFG|CFG scale|Seed|Size|Model|Hires|Denoising|Clip|ENSD)\s*:/i;
    const idx = s.search(HEADER_RE);
    if (idx > 0) {
      positive = s.slice(0, idx).trim() || undefined;
      tail = s.slice(idx).trim();
    }
  }

  const meta = parseHeaderLine(tail);
  if (positive) {
    // normalize weights
    positive = removeWeights(positive);
    if (negative) negative = removeWeights(negative);
    return { positive, negative, ...meta, raw };
  }
  return null;
}

/** Remove weight markers like :1.1, :0.8 etc. from text */
function removeWeights(text: string): string {
  // Remove weights inside parentheses e.g. (flower:1.1) -> (flower)
  let result = text.replace(/\(([^()]+?):[0-9.]+\)/g, "($1)");
  // Remove standalone weights e.g. flower:1.1 -> flower
  result = result.replace(/(\S+):[0-9.]+/g, "$1");
  return result;
}
