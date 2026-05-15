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
  "deepseek-ai/deepseek-v4-flash"
];

const PROSE_GUARD = "### IMPORTANT: You must write exclusively in natural language. Use of numerical digits (0-9) is STRICTLY FORBIDDEN. Do not use lists, numbered steps, or alphanumeric word-splitting. Deliver fluid, immersive narrative prose only.";

const ENABLE_SMART_TRUNCATION = true;
const TRUNCATION_TIERS = {
  small:  { threshold: 100,      keep: 60,  keepFirst: 0  },
  medium: { threshold: 300,      keep: 80,  keepFirst: 6  },
  large:  { threshold: 1000,     keep: 100, keepFirst: 10 },
  huge:   { threshold: Infinity, keep: 120, keepFirst: 15 }
};

const BACKOFF_BASE = 1000;
const BACKOFF_MAX = 16000;

let lastHit = null;
let failedAttempts = 0;
let currentModel = PRIMARY_MODEL;


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
  const patterns = [
    /^(as |just |you just |you had |having just |after |following |with |upon |in response|reacting|acknowledging|noting|seeing as|given that|since you|because you)/i,
    /^(you said|you mentioned|you asked|you told|you explained|you described|you stated)/i,
    /^(as you|as we|as the|as your|as i)/i,
    /^(it seems|it appears|it looks like|it sounds like)/i,
    /^(indeed|certainly|absolutely|of course|understood|i see|i understand|i hear)/i,
    /^(recap|summary|to summarize|in summary|to recap)/i
  ];
  return messages.map(msg => {
    if (msg.role !== "assistant" || typeof msg.content !== "string") return msg;
    const filteredLines = msg.content.split("\n").filter(line => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return true;
      return !patterns.some(p => p.test(trimmed));
    });
    return { role: msg.role, content: filteredLines.join("\n").trim() };
  });
}

function cleanNumberGlitches(messages) {
  return messages.map(msg => {
    if (typeof msg.content !== "string") return msg;
    let cleaned = msg.content;
    cleaned = cleaned.replace(/([a-zA-Z])\d+([a-zA-Z])/g, '$1$2');
    cleaned = cleaned.replace(/([a-zA-Z])\d+\b/g, '$1');
    cleaned = cleaned.replace(/^\d+\.\s+/gm, '');
    return { role: msg.role, content: cleaned };
  });
}

function injectPrefill(messages) {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (last.role !== "user") return messages;

  const prefills = [
    "The scene continues.",
    "A moment passes.",
    "The air shifts.",
    "Silence stretches between them.",
    "Something stirs.",
    "The world moves on."
  ];

  const prefill = prefills[Math.floor(Math.random() * prefills.length)];
  console.log("Injected prefill:", prefill);

  return messages.slice(0, -1).concat([
    { role: "assistant", content: prefill },
    last
  ]);
}

function truncateMessages(messages) {
  if (!ENABLE_SMART_TRUNCATION) return trimMessagesDynamic(messages);
  const tier = messages.length < 100 ? TRUNCATION_TIERS.small : messages.length < 300 ? TRUNCATION_TIERS.medium : messages.length < 1000 ? TRUNCATION_TIERS.large : TRUNCATION_TIERS.huge;
  if (messages.length <= tier.keep) return trimMessagesDynamic(messages);
  const truncated = messages.slice(0, tier.keepFirst).concat(messages.slice(-(tier.keep - tier.keepFirst)));
  return trimMessagesDynamic(truncated);
}

app.get("/", function(req, res) {
  recordHit(req);
  res.type("text").send("Proxy running");
});

app.get("/health", (req, res) => {
  recordHit(req);
  res.json({ status: "ok", primaryModel: PRIMARY_MODEL, currentModel, failedAttempts });
});

app.get("/v1", function(req, res) {
  recordHit(req);
  res.json({ status: "ok", message: "OpenAI-compatible API v1", endpoints: ["/v1/models", "/v1/chat/completions"] });
});

app.get("/v1/models", (req, res) => {
  recordHit(req);
  res.json({
    object: "list",
    data: [{ id: PRIMARY_MODEL, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "proxy" }]
  });
});

const OUTAGE_RETRY_LIMIT = 5;
const OUTAGE_WAIT = 15000;
const ALL_MODELS = ["deepseek-ai/deepseek-v4-flash", "deepseek-ai/deepseek-v4-pro"];

let lastWorkingModel = null;

async function makeNvidiaRequest(messages, temperature, max_tokens, stream, attemptNum = 0, outageRetry = 0) {
  // If we know a model was working recently, try it first
  const orderedModels = lastWorkingModel
    ? [lastWorkingModel, ...ALL_MODELS.filter(m => m !== lastWorkingModel)]
    : ALL_MODELS;

  // Never retry the same model that just failed - always move to next
  const modelIndex = Math.min(attemptNum, orderedModels.length - 1);
  const modelToUse = orderedModels[modelIndex];

  console.log("Attempt", attemptNum + 1, "- Using model", modelToUse, outageRetry > 0 ? `(outage retry ${outageRetry}/${OUTAGE_RETRY_LIMIT})` : "");

  try {
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`,
      { model: modelToUse, messages, temperature, max_tokens, stream, chat_template_kwargs: { enable_thinking: true, thinking: true } },
      { headers: { "Authorization": `Bearer ${API_KEY}`, "Content-Type": "application/json" }, timeout: 600000, responseType: stream ? "stream" : "json", validateStatus: function(status) { return true; } }
    );

    if (response.status === 200) {
      failedAttempts = 0;
      currentModel = modelToUse;
      lastWorkingModel = modelToUse;
      return response;
    }

    if (response.status === 429) {
      console.log("RATE LIMITED (429) - NVIDIA is overwhelmed. Backing off...");
      failedAttempts++;
      const retryAfter = (attemptNum + 1) * 5000;
      await new Promise(r => setTimeout(r, retryAfter));
      return makeNvidiaRequest(messages, temperature, max_tokens, stream, attemptNum + 1, outageRetry);
    }

    if (response.status === 503 || response.status === 504) {
      console.log("SERVER OUTAGE (" + response.status + ") on " + modelToUse + " - trying next model...");
      failedAttempts++;
      if (outageRetry < OUTAGE_RETRY_LIMIT) {
        await new Promise(r => setTimeout(r, getBackoffDelay(attemptNum)));
        return makeNvidiaRequest(messages, temperature, max_tokens, stream, attemptNum + 1, outageRetry + 1);
      }
      throw { isOutage: true };
    }

    console.log("Model", modelToUse, "returned status", response.status, "- trying next model...");
    failedAttempts++;
    if (attemptNum < ALL_MODELS.length * 2) {
      await new Promise(r => setTimeout(r, getBackoffDelay(attemptNum)));
      return makeNvidiaRequest(messages, temperature, max_tokens, stream, attemptNum + 1, outageRetry);
    }
    throw { response };

  } catch (error) {
    if (error.isOutage) throw error;
    console.log("Model", modelToUse, "failed:", error.message);
    failedAttempts++;

    // Keep bouncing between models
    if (attemptNum < ALL_MODELS.length * 2) {
      await new Promise(r => setTimeout(r, getBackoffDelay(attemptNum)));
      return makeNvidiaRequest(messages, temperature, max_tokens, stream, attemptNum + 1, outageRetry);
    }

    // All models exhausted — wait and retry if outage retries remain
    if (outageRetry < OUTAGE_RETRY_LIMIT) {
      console.log("All models failed - waiting", OUTAGE_WAIT / 1000, "seconds before trying again...");
      await new Promise(r => setTimeout(r, OUTAGE_WAIT));
      return makeNvidiaRequest(messages, temperature, max_tokens, stream, 0, outageRetry + 1);
    }

    throw error;
  }
}

async function handleChatCompletions(req, res) {
  recordHit(req);

  try {
    if (!API_KEY) return res.status(500).json({ error: { message: "Missing NIM_API_KEY" } });

    const body = req.body || {};
    let messages = Array.isArray(body.messages) ? body.messages : [];
    const temperature = 0.7;
    const max_tokens = Math.min(Math.max(body.max_tokens || 4000, 200), 8192);
    const stream = body.stream || false;

    const sysIdx = messages.findIndex(m => m.role === "system");
    if (sysIdx === -1) {
      messages.unshift({ role: "system", content: PROSE_GUARD });
    } else {
      messages[sysIdx].content += " " + PROSE_GUARD;
    }

    const totalChars = JSON.stringify(messages).length;
    console.log("Received", messages.length, "messages,", totalChars, "chars total");

    let processedMessages = injectPrefill(cleanNumberGlitches(truncateMessages(stripSummaryOpeners(messages))));

    const processedChars = JSON.stringify(processedMessages).length;
    if (processedMessages.length < messages.length) {
      console.log("Sending", processedMessages.length, "messages,", processedChars, "chars to NVIDIA");
    }

    const response = await makeNvidiaRequest(processedMessages, temperature, max_tokens, stream);

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      response.data.pipe(res);
      response.data.on("end", function() { console.log("Stream completed"); });
      response.data.on("error", function(err) { console.error("Stream error:", err); res.end(); });
      return;
    }

    let reply = response.data?.choices?.[0]?.message?.content || "";
    reply = reply.replace(/([a-zA-Z])\d+([a-zA-Z])/g, '$1$2');  // runn5ing -> running
    reply = reply.replace(/([a-zA-Z])\d+\b/g, '$1');             // ti16 -> ti (trims trailing digits)
    reply = reply.replace(/^\d+\.\s+/gm, '');

    res.setHeader("Content-Type", "application/json");
    res.json({
      id: response.data?.id || `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model || PRIMARY_MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: reply || " " }, finish_reason: "stop" }],
      usage: response.data?.usage || { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 }
    });

    console.log("Response sent -", reply.length, "chars, model:", currentModel);

  } catch (error) {
    const errMsg = error.message || (error.response ? `HTTP ${error.response.status}` : "No response from NVIDIA") || "Unknown error";
    console.error("ALL ATTEMPTS FAILED:", errMsg);
    console.error("Full error:", JSON.stringify(error.response?.data || error.code || "no details"));
    if (error.response?.status === 429) {
      return res.status(429).json({ error: { message: "Rate limit exceeded. Please wait a few minutes.", type: "rate_limit_error", code: 429 } });
    }
    if (error.isOutage) {
      return res.status(200).json({
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: PRIMARY_MODEL,
        choices: [{ index: 0, message: { role: "assistant", content: "NVIDIA servers are currently experiencing an outage. Please wait a moment and try again." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      });
    }
    res.status(500).json({ error: { message: error.message || "Unknown error occurred" } });
  }
}

app.post("/v1/chat/completions", handleChatCompletions);
app.post("/v1/chat/completions/", handleChatCompletions);
app.post("/chat/completions", handleChatCompletions);

app.post("/", async function(req, res) {
  recordHit(req);
  if (req.body && req.body.messages) {
    return handleChatCompletions(req, res);
  }
  res.type("text").send("POST received");
});

app.use(function(req, res) {
  recordHit(req);
  console.log("404 - Route not found:", req.method, req.path);
  res.status(404).json({ error: { message: "Route not found", method: req.method, path: req.path } });
});

app.listen(PORT, function() {
  console.log("Proxy active on port", PORT);
  console.log("Primary Model:", PRIMARY_MODEL);
  console.log("V4 Prose Guard: ENABLED");
  console.log("API Key:", API_KEY ? "Loaded" : "Missing");
});
