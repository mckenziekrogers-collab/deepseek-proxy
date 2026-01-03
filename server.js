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
const ENABLE_STREAMING = false;

// Context memory settings
const MAX_RECENT_MESSAGES = 100; // Keep only last 100 messages in full context
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

    // Initialize session memory if new
    if (!sessions[sessionId]) {
      sessions[sessionId] = {
        summary: "",
        messages: [],
      };
    }

    const session = sessions[sessionId];

    // Merge old summary + recent messages
    const recentMessages = session.messages.slice(-MAX_RECENT_MESSAGES);
    const combinedContext = [];

    // Add system summary if exists
    if (session.summary) {
      combinedContext.push({
        role: "system",
        content: `Memory Summary of previous conversation: ${session.summary}`,
      });
    }

    // Add recent messages
    combinedContext.push(...recentMessages);

    // Add new incoming messages
    combinedContext.push(...messages);

    // Send to NVIDIA API
    const response = await axios.post(
      "https://integrate.api.nvidia.com/v1/chat/completions",
      {
        model: MODEL,
        messages: combinedContext,
        temperature: req.body?.temperature ?? 0.7,
        max_tokens: req.body?.max_tokens ?? 2048,
        stream: ENABLE_STREAMING && req.body?.stream === true,
      },
      {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        responseType: ENABLE_STREAMING ? "stream" : "json",
        timeout: 120000,
      }
    );

    // Handle streaming (optional)
    if (ENABLE_STREAMING && req.body?.stream === true) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      response.data.pipe(res);
      return;
    }

    // Get assistant reply
    const reply = response.data?.choices?.[0]?.message?.content ?? "";

    // Save to session memory
    session.messages.push(...messages); // incoming
    session.messages.push({ role: "assistant", content: reply }); // reply

    // Update session summary every 50 messages
    if (session.messages.length > 50) {
      // Summarize older messages to compress memory
      const summaryContent = session.messages
        .slice(0, session.messages.length - MAX_RECENT_MESSAGES)
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n");

      // Here we could call the model to summarize, but for speed:
      session.summary = summaryContent; 
      // Remove old messages to keep memory small
      session.messages = session.messages.slice(-MAX_RECENT_MESSAGES);
    }

    // Return OpenAI-compatible response
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
      usage: response.data?.usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    });
  } catch (error) {
    console.error("❌ ERROR MESSAGE:", error.message);
    console.error("❌ ERROR DATA:", error.response?.data);
    console.error("❌ STATUS:", error.response?.status);

    res.status(error.response?.status || 500).json({
      error: error.response?.data || { message: error.message },
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Proxy running on port ${PORT}`);
  console.log(`🧠 Model: ${MODEL}`);
});
