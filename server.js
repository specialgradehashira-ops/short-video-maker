import express from "express";
import fetch from "node-fetch";
import { promises as fs } from "fs";
import { createWriteStream } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import crypto from "crypto";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import * as googleTTS from "google-tts-api";

/* ---------- Setup ---------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT_DIR = "/tmp/out";
const TMP_DIR = "/tmp";

const app = express();
app.use(express.json({ limit: "25mb" }));

// CORS (Hoppscotch/Postman Web)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-webhook-secret");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Serve finished files
app.use("/files", express.static(OUT_DIR, { maxAge: "1h", fallthrough: true }));

// Health / Debug
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("/debug/list", async (_req, res) => {
  try { await ensureDirs(); const files = await fs.readdir(OUT_DIR); res.json({ outDir: OUT_DIR, files }); }
  catch (e) { res.status(500).json({ error: e?.message || "read dir failed" }); }
});

/* ---------- Helpers ---------- */
function baseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || "http").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `${proto}://${host}`;
}

function verifySecret(req) {
  const sent = req.get("x-webhook-secret") || "";
  const expected = process.env.WEBHOOK_SECRET || "";
  return expected && sent && sent === expected;
}

async function ensureDirs() {
  await fs.mkdir(OUT_DIR, { recursive: true });
}

// STREAM download (works for Node & Web streams, no RAM spikes)
async function downloadTo(fileUrl, destPath, headers = {}) {
  const res = await fetch(fileUrl, { headers });
  if (!res.ok) throw new Error(`Download failed ${res.status} ${res.statusText}`);
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  const out = createWriteStream(destPath);

  if (res.body && typeof res.body.pipe === "function") {
    await pipeline(res.body, out);             // Node stream (PassThrough)
    return destPath;
  }
  if (res.body) {
    const nodeStream = Readable.fromWeb(res.body); // Web ReadableStream
    await pipeline(nodeStream, out);
    return destPath;
  }
  throw new Error("No response body to download");
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", d => (stderr += d.toString()));
    p.on("close", (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`ffmpeg exited ${code}:\n${stderr.split("\n").slice(-12).join("\n")}`));
    });
  });
}

function sanitizeForDrawtext(text) {
  return (text || "")
    .replace(/\\/g, "\\\\")     // \
    .replace(/:/g, "\\:")       // :
    .replace(/'/g, "\\'")       // '
    .replace(/%/g, "\\%")       // %
    .replace(/,/g, "\\,")       // ,
    .replace(/\[/g, "\\[")      // [
    .replace(/\]/g, "\\]")      // ]
    .replace(/\n/g, "\\n");     // newline
}

/* ---------- Media utils ---------- */
async function getDurationSec(filePath) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffprobe", ["-v","quiet","-print_format","json","-show_format", filePath], { stdio: ["ignore","pipe","pipe"] });
    let out = "";
    p.stdout.on("data", d => (out += d.toString()));
    p.on("close", () => {
      try {
        const j = JSON.parse(out || "{}");
        const sec = parseFloat(j?.format?.duration || "0");
        resolve(isFinite(sec) ? sec : 0);
      } catch (e) { reject(e); }
    });
  });
}

function splitForTTS(text, maxLen=180) {
  const parts = [];
  let buf = "";
  for (const ch of (text || "").trim()) {
    buf += ch;
    if (buf.length >= maxLen && /[\.!\?,;:]$/.test(buf)) { parts.push(buf.trim()); buf = ""; }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts.length ? parts : [text];
}

async function ttsForScene(text, lang="en") {
  const id = crypto.randomBytes(5).toString("hex");
  const chunks = splitForTTS(text);
  const partPaths = [];
  for (let i=0;i<chunks.length;i++) {
    const url = googleTTS.getAudioUrl(chunks[i], { lang, slow:false, host:"https://translate.google.com" });
    const pth = path.join(TMP_DIR, `vpart-${id}-${i}.mp3`);
    await downloadTo(url, pth);
    partPaths.push(pth);
  }
  const list = path.join(TMP_DIR, `vlist-${id}.txt`);
  await fs.writeFile(list, partPaths.map(p => `file '${p}'`).join("\n"));
  const voicePath = path.join(TMP_DIR, `voice-${id}.mp3`);
  await runFfmpeg(["-y","-f","concat","-safe","0","-i",list,"-c","copy",voicePath]);
  const durationSec = await getDurationSec(voicePath);
  return { voicePath, durationSec };
}

/* ---------- Pexels + video assembly ---------- */
async function fetchPexelsPool(query, perPage=25) {
  const key = process.env.PEXELS_API_KEY;
  if (!key) throw new Error("Missing PEXELS_API_KEY");
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${perPage}`;
  const res = await fetch(url, { headers: { Authorization: key } });
  if (!res.ok) throw new Error(`Pexels API error ${res.status}`);
  const json = await res.json();
  return Array.isArray(json.videos) ? json.videos : [];
}

function pickVideoFileForOrientation(video, orientation="portrait") {
  const files = Array.isArray(video.video_files) ? video.video_files : [];
  let candidates = files.filter(f => {
    const w = Number(f.width||0), h = Number(f.height||0);
    return orientation === "portrait" ? h >= w : w >= h;
  });
  if (!candidates.length) candidates = files;
  candidates.sort((a,b)=>(Number(b.width||0)*Number(b.height||0))-(Number(a.width||0)*Number(a.height||0)));
  return candidates[0];
}

// Use 720x1280 portrait by default to keep free-tier CPU/RAM lower.
// To switch back to 1080x1920, change 1280->1920 and 720->1080.
// Fit inside the target size while preserving aspect ratio, then pad to fill.
// Portrait target = 720x1280, Landscape target = 1280x720.
function scaleCropFor(orientation = "portrait") {
  if (orientation === "portrait") {
    // Fit within 720x1280, then pad to exactly 720x1280 (centered)
    return "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(720-iw)/2:(1280-ih)/2";
  }
  // Landscape
  return "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(1280-iw)/2:(720-ih)/2";
}


function drawtextFilter(text, position="bottom") {
  const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
  const safe = sanitizeForDrawtext(text||"");
  const yExpr = position==="center" ? "(h-text_h)/2" : position==="top" ? "text_h*0.8" : "h-(text_h*2)";
  const size = safe.length>220 ? 28 : safe.length>120 ? 32 : 36;
  return `drawtext=fontfile='${font}':text='${safe}':x=(w-text_w)/2:y=${yExpr}:fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=12:line_spacing=6`;
}

async function makeSubsegment(srcUrl, takeSec, idx, orientation, text, textPosition) {
  const srcPath = path.join(TMP_DIR, `src-${idx}-${crypto.randomBytes(4).toString("hex")}.mp4`);
  await downloadTo(srcUrl, srcPath);
  const vf = `${scaleCropFor(orientation)},${drawtextFilter(text, textPosition)}`;
  const segPath = path.join(TMP_DIR, `seg-${idx}-${crypto.randomBytes(4).toString("hex")}.mp4`);
  await runFfmpeg([
    "-y",
    "-i", srcPath,
    "-t", String(Math.max(0.6, takeSec)),
    "-vf", vf,
    "-an",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-threads", "1",
    segPath
  ]);
  return segPath;
}

// Build one scene: TTS voice + several DIFFERENT clips (no loops) to cover the voice length
async function buildSceneWithVoice(scene, idx, orientation="portrait", textPosition="bottom") {
  const { text="", search="", minClipSec=4, maxClips=4, lang="en" } = scene || {};
  const q = (search || text || "nature");

  // 1) TTS for this scene
  const { voicePath, durationSec: vSec } = await ttsForScene(text, lang);
  const targetSec = Math.max(3, Math.min(60, vSec)); // per-scene cap for free tier

  // 2) Get candidate clips
  const pool = await fetchPexelsPool(q, 25);
  if (!pool.length) throw new Error(`No stock videos for "${q}"`);
  const oriented = pool.map(v => ({ v, file: pickVideoFileForOrientation(v, orientation), dur: Number(v.duration||0) }))
                      .filter(x => x.file && x.file.link);
  oriented.sort((a,b)=> (b.dur||0) - (a.dur||0));

  // 3) Choose several different clips to cover the target time
  const chosen = [];
  let remaining = targetSec;
  for (const cand of oriented) {
    if (chosen.length >= maxClips) break;
    const take = Math.min(Math.max(minClipSec, Math.min(cand.dur || minClipSec, remaining)), remaining);
    if (take <= 0.75) continue;
    chosen.push({ url: cand.file.link, take });
    remaining -= take;
    if (remaining <= 0.75) break;
  }
  if (chosen.length === 0) {
    chosen.push({ url: oriented[0].file.link, take: Math.min(targetSec, Math.max(minClipSec, oriented[0].dur||minClipSec)) });
  }

  // 4) Normalize each piece (captioned)
  const segParts = [];
  for (let i=0;i<chosen.length;i++) {
    const part = chosen[i];
    const seg = await makeSubsegment(part.url, part.take, `${idx}-${i}`, orientation, text, textPosition);
    segParts.push(seg);
  }

  // 5) Concat to one scene video (video-only)
  const listPath = path.join(TMP_DIR, `list-${idx}-${crypto.randomBytes(4).toString("hex")}.txt`);
  await fs.writeFile(listPath, segParts.map(p => `file '${p}'`).join("\n"));
  const sceneVideo = path.join(TMP_DIR, `scene-${idx}-${crypto.randomBytes(4).toString("hex")}.mp4`);
  await runFfmpeg([
    "-y","-f","concat","-safe","0","-i",listPath,
    "-c:v","libx264","-preset","veryfast","-pix_fmt","yuv420p",
    "-movflags","+faststart",
    "-threads","1",
    sceneVideo
  ]);

  return { segPath: sceneVideo, voicePath };
}

async function concatSegments(segPaths, outPath) {
  const listPath = path.join(TMP_DIR, `concat-${crypto.randomBytes(5).toString("hex")}.txt`);
  await fs.writeFile(listPath, segPaths.map(p => `file '${p}'`).join("\n"));
  await runFfmpeg([
    "-y","-f","concat","-safe","0","-i",listPath,
    "-c:v","libx264","-preset","veryfast","-pix_fmt","yuv420p",
    "-movflags","+faststart",
    "-threads","1",
    outPath
  ]);
}

async function concatAudio(mp3Paths, outPath) {
  const listPath = path.join(TMP_DIR, `alist-${crypto.randomBytes(5).toString("hex")}.txt`);
  await fs.writeFile(listPath, mp3Paths.map(p => `file '${p}'`).join("\n"));
  await runFfmpeg(["-y","-f","concat","-safe","0","-i",listPath,"-c","copy",outPath]);
}

/* ---------- API ---------- */
app.post("/render", async (req, res) => {
  try {
    if (!verifySecret(req)) return res.status(401).json({ error: "Unauthorized" });

    let {
      scenes = [],                 // [{ text, search, minClipSec?, maxClips?, lang? }, ...]
      orientation = "portrait",    // "portrait" | "landscape"
      textPosition = "bottom",     // "bottom" | "center" | "top"
      outFormat = "mp4"
    } = req.body || {};

    if (!Array.isArray(scenes) || scenes.length === 0) {
      return res.status(400).json({ error: "Provide scenes[] with per-scene text (and optional search)." });
    }

    await ensureDirs();

    // Build each scene (voice + multi-clip video), then stitch
    const take = scenes.slice(0, 60); // safety cap for free tier
    const segPaths = [];
    const voicePaths = [];

    for (let i = 0; i < take.length; i++) {
      const { segPath, voicePath } = await buildSceneWithVoice(take[i], i, orientation, textPosition);
      segPaths.push(segPath);
      voicePaths.push(voicePath);
    }

    // Concat videos (video-only)
    const videoOnly = path.join(TMP_DIR, `video-${crypto.randomBytes(5).toString("hex")}.mp4`);
    await concatSegments(segPaths, videoOnly);

    // Concat voices
    const voiceAll = path.join(TMP_DIR, `voice-${crypto.randomBytes(5).toString("hex")}.mp3`);
    await concatAudio(voicePaths, voiceAll);

    // Mux video + voice (copy video; encode audio)
    const outId = crypto.randomBytes(6).toString("hex");
    const outPath = path.join(OUT_DIR, `video-${outId}.${outFormat}`);
    await runFfmpeg([
      "-y",
      "-i", videoOnly,
      "-i", voiceAll,
      "-map","0:v:0",
      "-map","1:a:0",
      "-c:v","copy",
      "-c:a","aac","-b:a","192k",
      "-shortest",
      "-movflags","+faststart",
      outPath
    ]);

    const url = `${baseUrl(req)}/files/${path.basename(outPath)}`;
    return res.json({
      status: "done",
      fileUrl: url,
      meta: { mode: "scenes+voice", scenes: segPaths.length, orientation }
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Render failed" });
  }
});

/* ---------- Start ---------- */
app.listen(process.env.PORT || 8080, () =>
  console.log(`Short-Video Maker listening on ${process.env.PORT || 8080}`)
);
