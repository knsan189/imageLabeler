import app from "./app/app.js";
import { VisionLabelsReq } from "./types";

app.post(
  "/api/v1/vision/labels/:name/:version",
  (req: VisionLabelsReq, res) => {
    console.log("===== Vision Request =====");
    console.log("Model:", req.params);
    console.log("Headers:", req.headers);

    const body = { ...req.body };

    if (Array.isArray(body.images)) {
      body.images = body.images.map((img, i) => {
        if (typeof img === "string") {
          return `data:image... (length=${img.length})`;
        }
        return img;
      });
    }

    console.log("Body:", JSON.stringify(body, null, 2));
    console.log("==========================");

    // 일단 빈 라벨 반환 (PhotoPrism 에러 방지)
    res.json({
      id: req.body?.id ?? null,
      model: {
        name: req.params.name,
        version: req.params.version,
      },
      result: { labels: [] },
    });
  }
);

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
  });
});
