const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));

app.use(express.json({ limit: "100mb" }));

const NIM_API_BASE = "https://integrate.api.nvidia.com/v1";
const API_KEY = process.env.NIM_API_KEY;
const PRIMARY_MODEL = "deepseek-ai/deepseek-v4-flash";

const FALLBACK_MODELS = [
  "deepseek-ai/deepseek-v4-pro",
  "deepseek-ai/deepseek-v3.2",
  "deepseek-ai/deepseek-v3.1-terminus"
];

// CRITICAL: V4-Flash Prose Guard
const PROSE_GUARD = "### IMPORTANT: You must write exclusively in natural language. Use of numerical digits (0-9) is STRICTLY FORBIDDEN. Do not use lists, numbered steps, or alphanumeric word-splitting. Deliver fluid, immersive narrative prose only.";

const ENABLE_SMART_TRUNCATION = true;
const TRUNCATION_TIERS = {
  small:  { threshold: 100,      keep: 100, keepFirst: 0  },
  medium: { threshold: 300,      keep: 150, keepFirst: 10 },
  large:  { threshold: 1000,     keep: 200, keepFirst: 20 },
  huge:   { threshold: Infinity, keep: 250, keepFirst: 30 }
};

const BACKOFF_BASE = 1000;
const BACKOFF_MAX = 16000;

let lastHit = null;
let failedAttempts = 0;
let currentModel = PRIMARY_MODEL;

const contextCache = new Map();
const CACHE_MAX_SIZE = 50;
const CACHE_TTL = 1000 * 60 * 10;

function getCacheKey(messages) {
  if (messages.length < 3) return null;
  const cacheableMessages = messages.slice(0, -1);
  return JSON.stringify(cacheableMessages).slice(0, 500);
}

function getFromCache(key) {
  if (!key) return null;
  const entry = contextCache.get(key);
  if (!entry || Date.now() - entry.time > CACHE_TTL) {
    contextCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCache(key, value) {
  if (!key) return;
  if (contextCache.size >= CACHE_MAX_SIZE) contextCache.delete(contextCache.keys().next().value);
  contextCache.set(key, { value, time: Date.now() });
}

function getBackoffDelay(attemptNum) {
  return Math.min(BACKOFF_BASE * Math.pow(2, attemptNum), BACKOFF_MAX) + (Math.random() * 500);
}

function recordHit(req) {
  lastHit = { time: new Date().toISOString(), method: req.method, path: req.path, url: req.url };
  console.log("HIT:", lastHit);
}

function trimMessagesDynamic(messages) {
  const total = messages.length;
  return messages.map((msg, i) => {
    if (typeof msg.content !== "string" || msg.role === "system" || i === total - 1) return msg;
    const dist = total - 1 - i;
    const maxChars = dist <= 2 ? 2000 : dist <= 6 ? 1200 : dist <= 15 ? 600 : dist <= 40 ? 300 : 150;
    return msg.content.length <= maxChars ? msg : { role: msg.role, content: msg.content.slice(0, maxChars) };
  });
}

function stripSummaryOpeners(messages) {
  const patterns = [/^(as |just |after |following |since |because |in response|with |upon)/i, /^(you said|you mentioned|you asked)/i, /^(indeed|certainly|absolutely|understood|i see)/i];
  return messages.map(msg => {
    if (msg.role !== "assistant" || typeof msg.content !== "string") return msg;
    const filteredLines = msg.content.split("\n").filter(line => !patterns.some(p => p.test(line.trim())));
    return { role: msg.role, content: filteredLines.join("\n").trim() };
  });
}

function truncateMessages(messages) {
  if (!ENABLE_SMART_TRUNCATION) return trimMessagesDynamic(messages);
  const tier = messages.length < 100 ? TRUNCATION_TIERS.small : messages.length < 300 ? TRUNCATION_TIERS.medium : messages.length < 1000 ? TRUNCATION_TIERS.large : TRUNCATION_TIERS.huge;
  if (messages.length <= tier.keep) return trimMessagesDynamic(messages);
  const truncated = messages.slice(0, tier.keepFirst).concat(messages.slice(-(tier.keep - tier.keepFirst)));
  return trimMessagesDynamic(truncated);
}

// ROUTING
app.get("/health", (req, res) => res.json({ status: "ok", primaryModel: PRIMARY_MODEL, currentModel, failedAttempts }));

app.get("/v1/models", (req, res) => res.json({
  object: "list",
  data: [{ id: PRIMARY_MODEL, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "proxy" }]
}));

async function makeNvidiaRequest(messages, temperature, max_tokens, stream, attemptNum = 0) {
  const modelToUse = attemptNum === 0 ? currentModel : FALLBACK_MODELS[attemptNum - 1];
  if (!modelToUse) throw new Error("All fallback models exhausted");

  try {
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, 
      { model: modelToUse, messages, temperature, max_tokens, stream },
      { headers: { "Authorization": `Bearer ${API_KEY}`, "Content-Type": "application/json" }, timeout: 600000, responseType: stream ? "stream" : "json" }
    );

    if (response.status === 200) {
      failedAttempts = 0;
      currentModel = modelToUse;
      return response;
    }
    throw { response };
  } catch (error) {
    if (attemptNum < FALLBACK_MODELS.length) {
      failedAttempts++;
      await new Promise(r => setTimeout(r, getBackoffDelay(attemptNum)));
      return makeNvidiaRequest(messages, temperature, max_tokens, stream, attemptNum + 1);
    }
    throw error;
  }
}

app.post("/v1/chat/completions", async function(req, res) {
  recordHit(req);
  res.setHeader("Content-Type", "application/json");

  try {
    if (!API_KEY) return res.status(500).json({ error: { message: "Missing NIM_API_KEY" } });

    const body = req.body || {};
    let messages = Array.isArray(body.messages) ? body.messages : [];
    
    // LOCKED AT 1.1: Day-one sweet spot for V4-Flash roleplay
    const temperature = 1.1; 
    const max_tokens = Math.min(Math.max(body.max_tokens || 4000, 200), 6000);
    const stream = body.stream || false;

    // INJECT PROSE GUARD
    const sysIdx = messages.findIndex(m => m.role === "system");
    if (sysIdx === -1) {
      messages.unshift({ role: "system", content: PROSE_GUARD });
    } else {
      messages[sysIdx].content += " " + PROSE_GUARD;
    }

    const cacheKey = getCacheKey(messages);
    const cachedContext = getFromCache(cacheKey);
    let processedMessages = cachedContext ? cachedContext.concat(messages.slice(-1)) : truncateMessages(stripSummaryOpeners(messages));
    if (!cachedContext) setCache(cacheKey, processedMessages.slice(0, -1));

    const response = await makeNvidiaRequest(processedMessages, temperature, max_tokens, stream);

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      response.data.pipe(res);
      return;
    }

    let reply = response.data?.choices?.[0]?.message?.content || "";

    // NUCLEAR REGEX: Remove digits jammed in words (e.g., 'runn5ing' -> 'running')
    reply = reply.replace(/([a-zA-Z])\d+([a-zA-Z])/g, '$1$2');
    // Remove leading list numbers (e.g., '1. ' at start of lines)
    reply = reply.replace(/^\d+\.\s+/gm, '');

    res.json({
      id: response.data?.id || `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model || PRIMARY_MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
      usage: response.data?.usage || { total_tokens: 0 }
    });

  } catch (error) {
    res.status(500).json({ error: { message: error.message } });
  }
});

app.listen(PORT, () => console.log(`Proxy active on ${PORT}. V4 Prose Guard: ENABLED.`));
