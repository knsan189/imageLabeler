import express from "express";
import { PORT } from "./const.js";

const app = express();

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));
app.listen(PORT, "0.0.0.0", () => {
  const addr = (app as any).address?.() || undefined;
  console.log(
    `Server running on http://${addr?.address ?? "localhost"}:${
      addr?.port ?? PORT
    }`
  );
});
export default app;
