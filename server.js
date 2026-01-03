const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ---------- CONFIG ----------
const API_KEY = process.env.NIM_API_KEY;

// Use a guaranteed-working model
const MODEL = process.env.NIM_MODEL || "deepseek-ai/deepseek-v3";

// Disable streaming by default (Render-safe)
const ENABLE_STREAMING = false;
// ----------------------------

if (!API_KEY) {
  console.warn("⚠️  WARNING: NIM_API_KEY is NOT set!");
}

app.get("/health", (req, res) => {
  res.json({ status: "ok", model: MODEL });
});

app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: [
      { id: MODEL, object: "model", created: Date.now(), owned_by: "nvidia" }
    ]
  });
});

app.post("/v1/chat/completions", async (req, res) => {
  console.log("REQUEST RECEIVED");

  try {
    const messages = req.body?.messages || [];
    const stream = ENABLE_STREAMING && req.body?.stream === true;

    if (!API_KEY) {
      return res.status(500).json({ error: "Missing NIM_API_KEY" });
    }

    const response = await axios.post(
      "https://integrate.api.nvidia.com/v1/chat/completions",
      {
        model: MODEL,
        messages,
        temperature: req.body?.temperature ?? 0.7,
        max_tokens: req.body?.max_tokens ?? 2048,
        stream
      },
      {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json"
        },
        responseType: stream ? "stream" : "json",
        timeout: 120000
      }
    );

    // ---------- STREAM MODE ----------
    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      response.data.pipe(res);
      return;
    }

    // ---------- NORMAL MODE ----------
    const reply = response.data?.choices?.[0]?.message?.content ?? "";

    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: MODEL,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: reply },
          finish_reason: "stop"
        }
      ],
      usage:
        response.data?.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
    });
  } catch (error) {
    console.error("❌ ERROR MESSAGE:", error.message);
    console.error("❌ ERROR DATA:", error.response?.data);
    console.error("❌ STATUS:", error.response?.status);

    res.status(error.response?.status || 500).json({
      error: error.response?.data || { message: error.message }
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Proxy running on port ${PORT}`);
  console.log(`🧠 Model: ${MODEL}`);
});
