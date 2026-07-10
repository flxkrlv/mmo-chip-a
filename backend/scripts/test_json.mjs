import express from "express";
import http from "http";
const app = express();
app.use(express.json({ limit: "50mb" }));
app.post("/test", (req, res) => {
  try {
    res.json({ ok: true, body: req.body });
  } catch (e) {
    res.json({ ok: false, error: (e as Error).message });
  }
});
app.post("/echo", (req, res) => {
  res.json({ raw: req.body });
});
app.post("/debug-body", (req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString();
    res.json({ raw, parsed: req.body });
  });
});
const server = app.listen(3086, () => {
  console.log("test server on 3086");
  http.request("http://localhost:3086/debug-body", {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  }).on("response", (res) => {
    let body = "";
    res.on("data", (c) => body += c);
    res.on("end", () => { console.log(body); server.close(); });
  }).end("{}");
});
