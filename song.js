// song.js
import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { fileURLToPath } from "url";
import { parseBuffer } from "music-metadata";

export const songRouter = express.Router();
export const songState = {}; // songState[room] = { queue, currentSinger, scores, scoreTimer }

// 上傳目錄
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(__dirname, "uploads", "songs");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Multer 設定
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const singer = req.body.singer || "guest";
    const ext = path.extname(file.originalname) || ".webm";
    cb(null, `${Date.now()}_${singer}${ext}`);
  }
});
const upload = multer({ storage });

// 上傳錄音
songRouter.post("/upload", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no audio" });

    const filePath = `/songs/${req.file.filename}`;

    // 嘗試用 music-metadata 讀取 duration
    let duration = 0;
    try {
      const metadata = await parseBuffer(fs.readFileSync(req.file.path));
      duration = metadata.format.duration || 0;
    } catch (e) {
      console.warn("無法讀取音檔長度，前端可自行計算", e.message);
    }

    res.json({ url: filePath, duration });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "upload failed" });
  }
});
