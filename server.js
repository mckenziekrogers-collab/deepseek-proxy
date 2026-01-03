const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "20mb" })); // big chats

const API_KEY = process.env.NIM_API_KEY;
const MODEL = process.env.NIM_MODEL || "deepseek-ai/deepseek-v3";

let lastHit = null;

function recordHit(req) {
  lastHit = {
    time: new Date().toISOString(),
    method: req.method,
    path: req.path,
    hasAuthHeader: !!req.headers?.authorization,
  };
  console.log("HIT:", lastHit);
}

// --- Basic endpoints
app.get("/", (req, res) => {
  recordHit(req);
  res.type("text").send(
    "DeepSeek proxy is running. Try /health, /v1/models, /whoami"
  );
});

app.get("/health", (req, res) => {
  recordHit(req);
  res.json({ status: "ok", model: MODEL });
});

app.get("/whoami", (req, res) => {
  recordHit(req);
  res.json({ lastHit, model: MODEL, hasNimKey: !!API_KEY });
});

app.get("/v1/models", (req, res) => {
  recordHit(req);
  res.json({
    object: "list",
    data: [{ id: MODEL, object: "model", created: Date.now(), owned_by: "nvidia" }],
  });
});

// --- Make GET on chat endpoints friendly (browser won’t show “Cannot GET”)
app.get(["/v1/chat/completions", "/chat/completions"], (req, res) => {
  recordHit(req);
  res
    .status(200)
    .type("text")
    .send("This endpoint requires POST with JSON body { messages: [...] }");
});

// --- Main handler used by BOTH routes
async function handleChat(req, res) {
  recordHit(req);

  try {
    if (!API_KEY) {
      return res.status(500).json({ error: { message: "Missing NIM_API_KEY on server" } });
    }

    const messages = req.body?.messages || [];
    const temperature = req.body?.temperature ?? 0.7;
    const max_tokens = req.body?.max_tokens ?? 2048;

    const response = await axios.post(
      "https://integrate.api.nvidia.com/v1/chat/completions",
      {
        model: MODEL,
        messages,
        temperature,
        max_tokens,
        stream: false, // keep Render stable
      },
      {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 120000,
      }
    );

    const reply = response.data?.choices?.[0]?.message?.content ?? "";

    // OpenAI-compatible response
    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: MODEL,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: reply },
          finish_reason: "stop",
        },
      ],
      usage: response.data?.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (error) {
    console.error("NVIDIA ERROR STATUS:", error.response?.status);
    console.error("NVIDIA ERROR DATA:", error.response?.data || error.message);

    res.status(error.response?.status || 500).json({
      error: error.response?.data || { message: error.message },
    });
  }
}

// POST routes (Janitor might call either)
app.post("/v1/chat/completions", handleChat);
app.post("/chat/completions", handleChat);

// Final 404 handler (VERY useful)
app.use((req, res) => {
  recordHit(req);
  res.status(404).json({
    error: {
      message: "Route not found",
      method: req.method,
      path: req.path,
      hint: "Try POST /v1/chat/completions or POST /chat/completions",
    },
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Model: ${MODEL}`);
});
