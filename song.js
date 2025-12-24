import express from "express";
import fs from "fs";
import path from "path";

export const songRouter = express.Router();
export const songState = {};   // songState[room] = { queue, currentSinger, scores, scoreTimer }
const __dirname = new URL('.', import.meta.url).pathname;
const uploadDir = path.join(__dirname, "uploads", "songs");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// 上傳錄音
songRouter.post("/upload", async (req, res) => {
  try {
    const { audioBase64, singer } = req.body;
    if (!audioBase64) return res.status(400).json({ error: "no audio" });

    const buffer = Buffer.from(audioBase64, "base64");
    const filename = `${Date.now()}_${singer}.webm`;
    const filepath = path.join(uploadDir, filename);

    fs.writeFileSync(filepath, buffer);

    res.json({ url: `/songs/${filename}` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "upload failed" });
  }
});
