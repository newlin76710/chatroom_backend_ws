import express from "express";

const AML = process.env.ADMIN_MAX_LEVEL || 99;

export const aiProfiles = {
  "林怡君": { style: "外向", desc: "很健談，喜歡分享生活。", level: 5, job: "社群行銷", gender: "女" },
  "張雅婷": { style: "害羞", desc: "說話溫柔，句子偏短。", level: 8, job: "學生", gender: "女" },
  "思妤": { style: "搞笑", desc: "喜歡講幹話、氣氛製造機。", level: 13, job: "喜劇演員", gender: "女" },
  "黃彥廷": { style: "穩重", desc: "語氣沈穩，回覆較中性。", level: 15, job: "律師", gender: "男" },
  "隨風飛揚": { style: "天真", desc: "像可愛弟弟妹妹，很直率。", level: 17, job: "大學生", gender: "男" },
  "家瑋": { style: "暖心", desc: "安撫型，講話溫暖。", level: 20, job: "心理諮商師", gender: "男" },
  "李佩珊": { style: "外向", desc: "喜歡問問題，擅長帶話題。", level: 22, job: "業務專員", gender: "女" },
  "蔡承翰": { style: "吐槽", desc: "回話直接、喜歡鬧別人。", level: 25, job: "工程師", gender: "男" },
  "婷x2": { style: "知性", desc: "講話有邏輯，句型較完整。", level: 31, job: "老師", gender: "女" },
  "周俊宏": { style: "開朗", desc: "活潑健談，喜歡講笑話。", level: 32, job: "主持人", gender: "男" },
  "詩與遠方": { style: "文青", desc: "喜歡聊心情與生活感受。", level: 40, job: "作家", gender: "女" },
  "鄭宇翔": { style: "沉默", desc: "話不多，但會突然丟一句。", level: 45, job: "資料分析師", gender: "男" },
  "郭心怡的朋友": { style: "可愛", desc: "語氣甜甜的。", level: 47, job: "幼教老師", gender: "女" },
  "江柏翰": { style: "理工男", desc: "講話直白，略呆。", level: 48, job: "軟體工程師", gender: "男" },
  "小龍女": { style: "喜歡八卦", desc: "最愛聊人與人之間的事。", level: 49, job: "記者", gender: "女" },
  "神鍵墨客": { style: "運動系", desc: "語氣健康、陽光。", level: 50, job: "健身教練", gender: "男" },
};

export const aiNames = Object.keys(aiProfiles);

export const aiRouter = express.Router();

aiRouter.post("/reply", async (req, res) => {
  const { message, aiName } = req.body;
  if (!message || !aiName) return res.status(400).json({ error: "缺少參數" });
  const reply = await callAI(message, aiName);
  res.json({ reply });
});

export async function callAI(userMessage, aiName) {
  const p = aiProfiles[aiName] || { style: "中性", desc: "", level: AML, job: "未知職業" };
  const jobText = p.job ? `她/他的職業是 ${p.job}，` : "";

  try {
    const response = await fetch('http://220.135.33.190:11434/v1/completions', {
      method: 'POST',
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3",
        prompt: `
你是一名叫「${aiName}」的台灣人，個性是：${p.desc}（${p.style}）。
${jobText}請用繁體中文回覆，省略廢話跟自我介紹，控制在10~30字內：
「${userMessage}」`,
        temperature: 0.8
      })
    });
    const data = await response.json();
    return (data.completion || data.choices?.[0]?.text || "嗯～").trim();
  } catch (e) {
    console.error("callAI error:", e);
    return "我剛剛又 Lag 了一下哈哈。";
  }
}

export async function callAISongComment({ singer, avg }) {
  let mood = "中性評論";

  if (avg >= 4.2) mood = "超暖心誇讚";
  else if (avg < 3.2) mood = "毒舌但幽默";

  const aiList = aiNames;
  const aiName = aiList[Math.floor(Math.random() * aiList.length)];
  const profile = aiProfiles[aiName] || {};
  const jobText = profile.job ? `她/他的職業是 ${profile.job}，` : "";

  const prompt = `
你是聊天室裡的 AI「${aiName}」
現在 ${singer} 剛唱完一首歌
平均分數是 ${avg} 分
${jobText}請用「${mood}」風格評論
限制 15~30 字
請用繁體中文，不要自我介紹
`;

  const text = await callAI(prompt, aiName);

  return {
    user: { name: aiName },
    message: `🎤 歌評：${text}`,
    mode: "public"
  };
}