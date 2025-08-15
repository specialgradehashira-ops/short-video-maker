import express from "express";
import fetch from "node-fetch";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Where finished videos are served from
const OUT_DIR = "/tmp/out";
const TMP_DIR = "/tmp";

const app = express();
app.use(express.json({ limit: "25mb" }));

// Allow browser clients (Hoppscotch/Postman Web) to call us
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-webhook-secret");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});


// Serve finished files so n8n can download them immediately
app.use("/files", express.static(OUT_DIR, { maxAge: "1h", fallthrough: true }));

// Health check for uptime pings
app.get("/healthz", (_, res) => res.status(200).send("ok"));

// Helper: detect public base URL (Render sets x-forwarded-* headers)
function baseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || "http").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `${proto}://${host}`;
}

// Simple shared-secret check so only your n8n can call this
function verifySecret(req) {
  const sent = req.get("x-webhook-secret") || "";
  const expected = process.env.WEBHOOK_SECRET || "";
  return expected && sent && sent === expected;
}

async function ensureDirs() {
  await fs.mkdir(OUT_DIR, { recursive: true });
}

// Download any URL to a local path
async function downloadTo(fileUrl, destPath, headers = {}) {
  const res = await fetch(fileUrl, { headers });
  if (!res.ok) throw new Error(`Download failed ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destPath, buf);
  return destPath;
}

// Get one stock clip from Pexels (requires PEXELS_API_KEY env var)
async function fetchPexelsClip(query) {
  const key = process.env.PEXELS_API_KEY;
  if (!key) throw new Error("Missing PEXELS_API_KEY");
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=1`;
  const res = await fetch(url, { headers: { Authorization: key } });
  if (!res.ok) throw new Error(`Pexels API error ${res.status}`);
  const json = await res.json();

  if (!json.videos?.length) throw new Error("No stock videos found for query");
  const first = json.videos[0];
  const file = first.video_files?.[0];
  if (!file?.link) throw new Error("No downloadable video file link");
  return file.link;
}

// Run ffmpeg and capture errors
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("close", (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`ffmpeg exited ${code}:\n${stderr.split("\n").slice(-10).join("\n")}`));
    });
  });
}

// Escape special chars for ffmpeg drawtext
function sanitizeForDrawtext(text) {
  return (text || "")
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/\n/g, "\\n");
}

// Main endpoint: POST /render
app.post("/render", async (req, res) => {
  try {
    if (!verifySecret(req)) return res.status(401).json({ error: "Unauthorized" });

    const started = Date.now();
    const timeoutSec = Number(process.env.MAX_RENDER_SECONDS || 300);
    const timeLeft = () => timeoutSec - Math.floor((Date.now() - started) / 1000);
    if (timeLeft() <= 0) return res.status(504).json({ error: "Timeout before start" });

    // Inputs from n8n (all optional with defaults)
    let {
      scriptText = "Your on-screen caption text goes here.",
      stockQuery = "city sunrise",
      musicUrl = "",
      outFormat = "mp4",
      textPosition = "bottom" // 'bottom' or 'center'
    } = req.body || {};

    await ensureDirs();

    // 1) Fetch a stock clip
    const clipUrl = await fetchPexelsClip(stockQuery);
    const clipPath = path.join(TMP_DIR, `clip-${crypto.randomBytes(4).toString("hex")}.mp4`);
    await downloadTo(clipUrl, clipPath);

    // 2) Optional background music
    let musicPath = "";
    if (musicUrl) {
      musicPath = path.join(TMP_DIR, `music-${crypto.randomBytes(4).toString("hex")}.mp3`);
      await downloadTo(musicUrl, musicPath);
    }

    // 3) Overlay caption with drawtext
    const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
    const text = sanitizeForDrawtext(scriptText);

    const outId = crypto.randomBytes(6).toString("hex");
    const outPath = path.join(OUT_DIR, `video-${outId}.${outFormat}`);

    const yExpr = textPosition === "center" ? "(h-text_h)/2" : "h-(text_h*2)";
    const vf = [
      `drawtext=fontfile='${font}':text='${text}':x=(w-text_w)/2:y=${yExpr}:fontsize=36:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=12:line_spacing=6`,
      "format=yuv420p"
    ].join(",");

    const args = [
      "-y",
      "-i", clipPath,
      ...(musicPath ? ["-i", musicPath] : []),
      "-filter:v", vf,
      "-map", "0:v:0",
      ...(musicPath ? ["-map", "1:a:0"] : []),
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-pix_fmt", "yuv420p",
      ...(musicPath ? ["-c:a", "aac", "-b:a", "192k"] : []),
      "-shortest",
      outPath
    ];

    await runFfmpeg(args);

    const url = `${baseUrl(req)}/files/${path.basename(outPath)}`;
    return res.json({
      status: "done",
      fileUrl: url,
      meta: { format: outFormat, source: "pexels", query: stockQuery }
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Render failed" });
  }
});

// Start server
app.listen(process.env.PORT || 8080, () =>
  console.log(`Short-Video Maker listening on ${process.env.PORT || 8080}`)
);
