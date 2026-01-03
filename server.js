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
app.post
