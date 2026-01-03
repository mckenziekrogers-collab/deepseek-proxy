const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "20mb" }));

const API_KEY = process.env.NIM_API_KEY;
const MODEL = process.env.NIM_MODEL || "deepseek-ai/deepseek-v3";

let lastHit = null;
function recordHit(req) {
  lastHit = {
    time: new Date().toISOString(),
    method: req.method,
    path: req.path,
  };
  console.log("HIT:", lastHit);
}

app.get("/", (req, res) => {
  recordHit(req);
  res.type("text").send("Proxy up. Try /health, /whoami, /upstream/models");
});

app.get("/health", (req, res) => {
  recordHit(req);
  res.json({ status: "ok", model: MODEL, hasNimKey: !!API_KEY });
});

app.get("/whoami", (req, res) => {
  recordHit(req);
  res.json({ lastHit, model: MODEL, hasNimKey: !!API_KEY });
});

// ✅ THIS is the route you’re missing right now:
app.get("/upstream/models", async (req, res) => {
  recordHit(req);
  try {
    if (!API_KEY) {
      return res.status(500).json({ error: { message: "Missing NIM_API_KEY" } });
    }
    const r = await axios.get("https://integrate.api.nvidia.com/v1/models", {
      headers: { Authorization: `Bearer ${API_KEY}` },
      timeout: 60000,
    });
    res.json(r.data);
  } catch (e) {
    res.status(e.response?.status || 500).json(e.response?.data || { message: e.message });
  }
});

// Optional: OpenAI-style model list for clients
app.get("/v1/models", (req, res) => {
  recordHit(req);
  res.json({
    object: "list",
    data: [{ id: MODEL, object: "model", created: Date.now(), owned_by: "proxy" }],
  });
});

// Friendly GET message for browser visits
app.get(
  ["/v1/chat/completions", "/v1/chat/completions/", "/chat/completions", "/chat/completions/", "/v1", "/v1/"],
  (req, res) => {
    recordHit(req);
    res.status(200).type("text").send("Use POST with JSON body { messages: [...] }");
  }
);

async function handleChat(req, res) {
  recordHit(req);

  try {
    if (!API_KEY) {
      return res.status(500).json({ error: { message: "Missing NIM_API_KEY" } });
    }

    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const temperature = body.temperature ?? 0.7;
    const max_tokens = body.max_tokens ?? 2048;

    const response = await axios.post(
      "https://integrate.api.nvidia.com/v1/chat/completions",
      { model: MODEL, messages, temperature, max_tokens, stream: false },
      {
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        timeout: 120000,
      }
    );

    const reply = response.data?.choices?.[0]?.message?.content ?? "";

    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
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

// Bulletproof POST routes (covers Janitor oddities)
app.post(
  [
    "/v1/chat/completions",
    "/v1/chat/completions/",
    "/chat/completions",
    "/chat/completions/",
    "/v1",
    "/v1/",
    "/",
    "",
  ],
  handleChat
);

// Catch-all 404 so we can see what’s being hit
app.use((req, res) => {
  recordHit(req);
  res.status(404).json({ error: { message: "Route not found", method: req.method, path: req.path } });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
