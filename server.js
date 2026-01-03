const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ---------- CONFIG ----------
const API_KEY = process.env.NIM_API_KEY;
const MODEL = process.env.NIM_MODEL || "deepseek-ai/deepseek-v3";
const MAX_RECENT_MESSAGES = 100; // Only keep last 100 messages for speed
const sessions = {}; // In-memory session memory
// ----------------------------

// ---------- HEALTH ----------
app.get("/health", (req, res) => {
  res.json({ status: "ok", model: MODEL });
});

// ---------- LIST MODELS ----------
app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: [{ id: MODEL, object: "model", created: Date.now(), owned_by: "nvidia" }],
  });
});

// ---------- CHAT COMPLETIONS ----------
app.post("/v1/chat/completions", async (req, res) => {
  try {
    const sessionId = req.body?.session_id || "default";
    const messages = req.body?.messages || [];

    if (!API_KEY) return res.status(500).json({ error: "Missing NIM_API_KEY" });

    // Initialize session if needed
    if (!sessions[sessionId]) sessions[sessionId] = { summary: "", messages: [] };
    const session = sessions[sessionId];

    // Combine previous summary + recent messages
    const recentMessages = session.messages.slice(-MAX_RECENT_MESSAGES);
    const context = [];

    if (session.summary) {
      context.push({
        role: "system",
        content: `Summary of previous conversation: ${session.summary}`,
      });
    }

    context.push(...recentMessages, ...messages);

    // Call NVIDIA DeepSeek API
    const response = await axios.post(
      "https://integrate.api.nvidia.com/v1/chat/completions",
      {
        model: MODEL,
        messages: context,
        temperature: req.body?.temperature ?? 0.7,
        max_tokens: req.body?.max_tokens ?? 2048,
        stream: false, // streaming disabled for Render
      },
      {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        responseType: "json",
        timeout: 120000,
      }
    );

    const reply = response.data?.choices?.[0]?.message?.content ?? "";

    // Save messages to session memory
    session.messages.push(...messages, { role: "assistant", content: reply });

    // Summarize old messages if memory too big
    if (session.messages.length > 50) {
      const oldMessages = session.messages
        .slice(0, session.messages.length - MAX_RECENT_MESSAGES)
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n");
      session.summary = oldMessages; // could be improved with real summarization
      session.messages = session.messages.slice(-MAX_RECENT_MESSAGES);
    }

    // Return OpenAI-compatible response
    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
      usage: response.data?.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (error) {
    console.error("❌ ERROR:", error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ error: error.response?.data || { message: error.message } });
  }
});

// Optional GET route to prevent browser 404
app.get("/v1/chat/completions", (req, res) => {
  res.send("POST requests only for chat completions. Use Janitor AI or POST tools.");
});

app.listen(PORT, () => {
  console.log(`🚀 Proxy running on port ${PORT}`);
  console.log(`🧠 Model: ${MODEL}`);
});
