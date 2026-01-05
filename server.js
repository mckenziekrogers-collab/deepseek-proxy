// server.js - OpenAI to NVIDIA NIM Proxy (DeepSeek V3.1)
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: "20mb" }));

// NVIDIA NIM API configuration
const NIM_API_BASE = "https://integrate.api.nvidia.com/v1";
const API_KEY = process.env.NIM_API_KEY;
const MODEL = process.env.NIM_MODEL || "deepseek-ai/deepseek-v3.1";

// Request tracking
let lastHit = null;
function recordHit(req) {
  lastHit = {
    time: new Date().toISOString(),
    method: req.method,
    path: req.path,
    url: req.url,
  };
  console.log("🔵 HIT:", lastHit);
}

// Root endpoint
app.get("/", (req, res) => {
  recordHit(req);
  res.type("text").send("✅ Proxy running! Try /health or POST to /v1/chat/completions");
});

// Health check endpoint
app.get("/health", (req, res) => {
  recordHit(req);
  res.json({ 
    status: "ok", 
    service: "OpenAI to NVIDIA NIM Proxy",
    model: MODEL,
    hasNimKey: !!API_KEY
  });
});

// Whoami debug endpoint
app.get("/whoami", (req, res) => {
  recordHit(req);
  res.json({ 
    lastHit, 
    model: MODEL, 
    hasNimKey: !!API_KEY
  });
});

// Upstream models endpoint
app.get("/upstream/models", async (req, res) => {
  recordHit(req);
  try {
    if (!API_KEY) {
      return res.status(500).json({ error: { message: "Missing NIM_API_KEY" } });
    }
    const r = await axios.get(`${NIM_API_BASE}/models`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      timeout: 60000,
    });
    res.json(r.data);
  } catch (e) {
    res.status(e.response?.status || 500).json(e.response?.data || { message: e.message });
  }
});

// v1 base route
app.get("/v1", (req, res) => {
  recordHit(req);
  res.json({ 
    status: "ok",
    message: "OpenAI-compatible API v1",
    endpoints: ["/v1/models", "/v1/chat/completions"]
  });
});

// OpenAI-style model list
app.get("/v1/models", (req, res) => {
  recordHit(req);
  res.json({
    object: "list",
    data: [
      { id: "gpt-4", object: "model", created: Date.now(), owned_by: "proxy" },
      { id: "gpt-4o", object: "model", created: Date.now(), owned_by: "proxy" },
      { id: MODEL, object: "model", created: Date.now(), owned_by: "proxy" }
    ],
  });
});

// Main chat completion handler
app.post("/v1/chat/completions", async (req, res) => {
  recordHit(req);
  console.log("📨 POST /v1/chat/completions - Body:", JSON.stringify(req.body).substring(0, 200));
  
  try {
    if (!API_KEY) {
      return res.status(500).json({ error: { message: "Missing NIM_API_KEY" } });
    }

    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const temperature = body.temperature ?? 0.7;
    // Ensure minimum 150 tokens, override if Janitor sends too low
    const max_tokens = Math.max(body.max_tokens ?? 8192, 150);

    console.log(`✅ Routing ${messages.length} messages to: ${MODEL}`);

    const nimRequest = {
      model: MODEL,
      messages: messages,
      temperature: temperature,
      max_tokens: max_tokens,
      stream: false
    };

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: { 
        Authorization: `Bearer ${API_KEY}`, 
        "Content-Type": "application/json" 
      },
      timeout: 120000
    });

    const reply = response.data?.choices?.[0]?.message?.content || "";

    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model || MODEL,
      choices: [
        { 
          index: 0, 
          message: { 
            role: "assistant", 
            content: reply 
          }, 
          finish_reason: response.data?.choices?.[0]?.finish_reason || "stop" 
        }
      ],
      usage: response.data?.usage || { 
        prompt_tokens: 0, 
        completion_tokens: 0, 
        total_tokens: 0 
      }
    });

    console.log("✅ Response sent successfully");

  } catch (error) {
    console.error("❌ ERROR:", error.message);
    console.error("❌ NVIDIA STATUS:", error.response?.status);
    console.error("❌ NVIDIA DATA:", JSON.stringify(error.response?.data));
    
    res.status(error.response?.status || 500).json({
      error: error.response?.data || { 
        message: error.message,
        type: 'invalid_request_error'
      }
    });
  }
});

// Alternative routes for compatibility
app.post("/v1/chat/completions/", (req, res, next) => {
  req.url = "/v1/chat/completions";
  app.handle(req, res, next);
});

app.post("/chat/completions", (req, res, next) => {
  req.url = "/v1/chat/completions";
  app.handle(req, res, next);
});

app.post("/", async (req, res) => {
  recordHit(req);
  // Check if it's a chat request
  if (req.body && req.body.messages) {
    req.url = "/v1/chat/completions";
    return app.handle(req, res);
  }
  res.type("text").send("✅ POST received! For chat, use /v1/chat/completions");
});

// Catch-all 404
app.use((req, res) => {
  recordHit(req);
  console.log("❌ 404 - Route not found:", req.method, req.path);
  res.status(404).json({ 
    error: { 
      message: "Route not found", 
      method: req.method, 
      path: req.path,
      url: req.url
    } 
  });
});

app.listen(PORT, () => {
  console.log("=".repeat(50));
  console.log("🚀 OpenAI to NVIDIA NIM Proxy");
  console.log("=".repeat(50));
  console.log(`📡 Port: ${PORT}`);
  console.log(`🤖 Model: ${MODEL}`);
  console.log(`🔑 API Key: ${API_KEY ? "✅ Loaded" : "❌ Missing"}`);
  console.log(`🌐 Health: http://localhost:${PORT}/health`);
  console.log("=".repeat(50));
});
