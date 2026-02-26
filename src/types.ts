import { Request } from "express";

export interface VisionLabelsRequest {
  id?: string;

  model?: string;
  version?: string;

  // FileScheme: base64 일 때
  images?: string[]; // ["data:image/jpeg;base64,..."]

  // FileScheme: http 일 때
  url?: string; // 원본 또는 preview URL

  // 일부 설정에서 prompt 전달 가능
  prompt?: string;

  // 기타 내부 필드가 붙을 수 있음
  [key: string]: unknown;
}

export type VisionLabelsReq = Request<
  {
    name: string;
    version: string;
  },
  any,
  VisionLabelsRequest
>;

export interface VisionLabelsResponse {
  id?: string | null;

  model: {
    name: string;
    version: string;
  };

  result: {
    labels: VisionLabel[];
  };
}

export interface VisionLabel {
  name: string;
  confidence: number; // 0~1
  topicality: number; // 0~1
}
