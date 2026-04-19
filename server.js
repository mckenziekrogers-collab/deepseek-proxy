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
const PRIMARY_MODEL = "deepseek-ai/deepseek-v3.2";

const FALLBACK_MODELS = [
  "deepseek-ai/deepseek-v3.1-terminus",
  "deepseek-ai/deepseek-v3.2",
  "deepseek-ai/deepseek-v3.1-terminus",
  "deepseek-ai/deepseek-v3.2"
];

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
  if (messages.length < 3) { return null; }
  const cacheableMessages = messages.slice(0, -1);
  return JSON.stringify(cacheableMessages).slice(0, 500);
}

function getFromCache(key) {
  if (!key) { return null; }
  const entry = contextCache.get(key);
  if (!entry) { return null; }
  if (Date.now() - entry.time > CACHE_TTL) {
    contextCache.delete(key);
    return null;
  }
  console.log("Cache hit - reusing context");
  return entry.value;
}

function setCache(key, value) {
  if (!key) { return; }
  if (contextCache.size >= CACHE_MAX_SIZE) {
    const firstKey = contextCache.keys().next().value;
    contextCache.delete(firstKey);
  }
  contextCache.set(key, { value: value, time: Date.now() });
}

function getBackoffDelay(attemptNum) {
  const delay = Math.min(BACKOFF_BASE * Math.pow(2, attemptNum), BACKOFF_MAX);
  const jitter = Math.random() * 500;
  return delay + jitter;
}

function recordHit(req) {
  lastHit = {
    time: new Date().toISOString(),
    method: req.method,
    path: req.path,
    url: req.url
  };
  console.log("HIT:", lastHit);
}

function trimMessagesDynamic(messages) {
  const total = messages.length;
  return messages.map(function(msg, i) {
    if (typeof msg.content !== "string") { return msg; }
    if (msg.role === "system") { return msg; }
    if (i === total - 1) { return msg; }

    const distanceFromEnd = total - 1 - i;
    let maxChars;
    if (distanceFromEnd <= 2) {
      maxChars = 2000;
    } else if (distanceFromEnd <= 6) {
      maxChars = 1200;
    } else if (distanceFromEnd <= 15) {
      maxChars = 600;
    } else if (distanceFromEnd <= 40) {
      maxChars = 300;
    } else {
      maxChars = 150;
    }

    if (msg.content.length <= maxChars) { return msg; }

    return {
      role: msg.role,
      content: msg.content.slice(0, maxChars)
    };
  });
}

function injectPrefill(messages) {
  if (messages.length === 0) { return messages; }
  const last = messages[messages.length - 1];
  if (last.role !== "user") { return messages; }

  const prefills = [
    "The scene continues.",
    "A moment passes.",
    "The air shifts.",
    "Silence stretches between them.",
    "Something stirs.",
    "The world moves on."
  ];

  const prefill = prefills[Math.floor(Math.random() * prefills.length)];

  const injected = messages.slice(0, messages.length - 1).concat([
    { role: "assistant", content: prefill },
    last
  ]);

  console.log("Injected prefill:", prefill);
  return injected;
}

function trimLastUserMessage(messages) {
  const lastUserIndex = messages.map(function(m) { return m.role; }).lastIndexOf("user");
  if (lastUserIndex === -1) { return messages; }

  const lastUser = messages[lastUserIndex];
  if (typeof lastUser.content !== "string") { return messages; }
  if (lastUser.content.length <= 800) { return messages; }

  const trimmed = messages.slice();
  trimmed[lastUserIndex] = {
    role: "user",
    content: lastUser.content.slice(0, 800)
  };
  console.log("Trimmed last user message from", lastUser.content.length, "to 800 chars");
  return trimmed;
}

function stripSummaryOpeners(messages) {
  const summaryPatterns = [
    /^(as |just |you just |you had |having just |after |following |with |upon |in response|reacting|acknowledging|noting|seeing as|given that|since you|because you)/i,
    /^(you said|you mentioned|you asked|you told|you explained|you described|you stated)/i,
    /^(as you|as we|as the|as your|as i)/i,
    /^(it seems|it appears|it looks like|it sounds like)/i,
    /^(indeed|certainly|absolutely|of course|understood|i see|i understand|i hear)/i,
    /^(recap|summary|to summarize|in summary|to recap)/i
  ];

  return messages.map(function(msg) {
    if (msg.role !== "assistant") { return msg; }
    if (typeof msg.content !== "string") { return msg; }

    const lines = msg.content.split("\n");
    const filteredLines = lines.filter(function(line) {
      const trimmed = line.trim();
      if (trimmed.length === 0) { return true; }
      for (let i = 0; i < summaryPatterns.length; i++) {
        if (summaryPatterns[i].test(trimmed)) { return false; }
      }
      return true;
    });

    return {
      role: msg.role,
      content: filteredLines.join("\n").trim()
    };
  });
}

function truncateMessages(messages) {
  if (!ENABLE_SMART_TRUNCATION) {
    return trimMessagesDynamic(messages);
  }

  let tier;
  if (messages.length < TRUNCATION_TIERS.small.threshold) {
    tier = TRUNCATION_TIERS.small;
  } else if (messages.length < TRUNCATION_TIERS.medium.threshold) {
    tier = TRUNCATION_TIERS.medium;
  } else if (messages.length < TRUNCATION_TIERS.large.threshold) {
    tier = TRUNCATION_TIERS.large;
  } else {
    tier = TRUNCATION_TIERS.huge;
  }

  if (messages.length <= tier.keep) {
    console.log("Conversation size:", messages.length, "messages - sending all");
    return trimMessagesDynamic(messages);
  }

  console.log("Long conversation detected:", messages.length, "messages");
  console.log("Truncating to", tier.keep, "messages");

  const firstMessages = tier.keepFirst > 0 ? messages.slice(0, tier.keepFirst) : [];
  const recentMessages = messages.slice(-(tier.keep - tier.keepFirst));
  const truncated = firstMessages.concat(recentMessages);

  console.log("Truncated from", messages.length, "to", truncated.length, "messages");
  return trimMessagesDynamic(truncated);
}

app.get("/", function(req, res) {
  recordHit(req);
  res.type("text").send("Proxy running");
});

app.get("/health", function(req, res) {
  recordHit(req);
  res.json({
    status: "ok",
    service: "OpenAI to NVIDIA NIM Proxy",
    primaryModel: PRIMARY_MODEL,
    currentModel: currentModel,
    failedAttempts: failedAttempts,
    fallbackModels: FALLBACK_MODELS.length,
    cacheSize: contextCache.size,
    hasNimKey: !!API_KEY,
    antiAnalyzing: true,
    dynamicTrimming: true,
    streaming: true,
    exponentialBackoff: true
  });
});

app.get("/whoami", function(req, res) {
  recordHit(req);
  res.json({
    lastHit: lastHit,
    primaryModel: PRIMARY_MODEL,
    currentModel: currentModel,
    failedAttempts: failedAttempts,
    fallbackModels: FALLBACK_MODELS,
    cacheSize: contextCache.size,
    hasNimKey: !!API_KEY
  });
});

app.get("/upstream/models", async function(req, res) {
  recordHit(req);
  try {
    if (!API_KEY) {
      return res.status(500).json({ error: { message: "Missing NIM_API_KEY" } });
    }
    const r = await axios.get(NIM_API_BASE + "/models", {
      headers: { Authorization: "Bearer " + API_KEY },
      timeout: 60000
    });
    res.json(r.data);
  } catch (e) {
    res.status(e.response ? e.response.status : 500).json(e.response ? e.response.data : { message: e.message });
  }
});

app.get("/v1", function(req, res) {
  recordHit(req);
  res.json({
    status: "ok",
    message: "OpenAI-compatible API v1",
    endpoints: ["/v1/models", "/v1/chat/completions"]
  });
});

app.get("/v1/models", function(req, res) {
  recordHit(req);
  res.json({
    object: "list",
    data: [
      { id: "gpt-4",         object: "model", created: Math.floor(Date.now() / 1000), owned_by: "proxy" },
      { id: "gpt-4o",        object: "model", created: Math.floor(Date.now() / 1000), owned_by: "proxy" },
      { id: "gpt-3.5-turbo", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "proxy" },
      { id: PRIMARY_MODEL,   object: "model", created: Math.floor(Date.now() / 1000), owned_by: "proxy" }
    ]
  });
});

async function makeNvidiaRequest(messages, temperature, max_tokens, stream, attemptNum) {
  attemptNum = attemptNum || 0;
  const modelToUse = attemptNum === 0 ? currentModel : FALLBACK_MODELS[attemptNum - 1];

  if (!modelToUse) {
    throw new Error("All fallback models exhausted");
  }

  console.log("Attempt", attemptNum + 1, "- Using model", modelToUse);

  try {
    const requestHeaders = {};
    requestHeaders["Authorization"] = "Bearer " + API_KEY;
    requestHeaders["Content-Type"] = "application/json";

    const response = await axios.post(
      NIM_API_BASE + "/chat/completions",
      {
        model: modelToUse,
        messages: messages,
        temperature: temperature,
        max_tokens: max_tokens,
        stream: stream
      },
      {
        headers: requestHeaders,
        timeout: 600000,
        responseType: stream ? "stream" : "json",
        validateStatus: function(status) { return status < 500; }
      }
    );

    if (response.status === 200) {
      failedAttempts = 0;
      if (modelToUse !== currentModel) {
        console.log("Switched to", modelToUse);
        currentModel = modelToUse;
      }
      return response;
    }

    if (response.status === 429 || (response.status >= 400 && response.status < 500)) {
      console.log("Model", modelToUse, "returned", response.status, "trying fallback with backoff");
      if (attemptNum < FALLBACK_MODELS.length) {
        failedAttempts++;
        const delay = getBackoffDelay(attemptNum);
        console.log("Waiting", Math.round(delay), "ms before retry");
        await new Promise(function(resolve) { setTimeout(resolve, delay); });
        return makeNvidiaRequest(messages, temperature, max_tokens, stream, attemptNum + 1);
      }
      throw { response: response };
    }

    throw { response: response };

  } catch (error) {
    console.log("Model", modelToUse, "failed:", error.message);
    if (attemptNum < FALLBACK_MODELS.length) {
      failedAttempts++;
      const delay = getBackoffDelay(attemptNum);
      console.log("Waiting", Math.round(delay), "ms before retry");
      await new Promise(function(resolve) { setTimeout(resolve, delay); });
      return makeNvidiaRequest(messages, temperature, max_tokens, stream, attemptNum + 1);
    }
    throw error;
  }
}

app.post("/v1/chat/completions", async function(req, res) {
  recordHit(req);
  console.log("POST /v1/chat/completions");

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  try {
    if (!API_KEY) {
      return res.status(500).json({ error: { message: "Missing NIM_API_KEY" } });
    }

    const body = req.body || {};
    let messages = Array.isArray(body.messages) ? body.messages : [];
    const temperature = body.temperature !== undefined ? body.temperature : 0.7;
    const requestedMaxTokens = body.max_tokens !== undefined ? body.max_tokens : 4000;
    const max_tokens = Math.min(Math.max(requestedMaxTokens, 200), 6000);
    const stream = body.stream !== undefined ? body.stream : false;

    const hasSystemMessage = messages.some(function(msg) { return msg.role === "system"; });
    if (!hasSystemMessage) {
      const systemMsg = {
        role: "system",
        content: "You are a character in a collaborative roleplay story. The user writes their character's actions and dialogue. You write ONLY your character's response - what your character does, says, thinks, and how the scene reacts. Never rewrite, expand, repeat, summarize, or paraphrase what the user just wrote. Never acknowledge the user's input. Your response picks up exactly where the user's message ends and moves the story forward. Write only new content. Stay in third person present tense."
      };
      messages = [systemMsg].concat(messages);
      console.log("Added system message");
    }

    // Strip duplicate system messages on long chats — keep only the first one
    if (messages.length > 5) {
      var seenSystem = false;
      messages = messages.filter(function(msg) {
        if (msg.role === "system") {
          if (!seenSystem) {
            seenSystem = true;
            return true;
          }
          return false;
        }
        return true;
      });
      console.log("Deduplicated system messages");
    }

    const totalChars = JSON.stringify(messages).length;
    console.log("Received", messages.length, "messages,", totalChars, "chars total");

    const cacheKey = getCacheKey(messages);
    const cachedContext = getFromCache(cacheKey);

    let processedMessages;
    if (cachedContext) {
      processedMessages = cachedContext.concat(messages.slice(-1));
    } else {
      processedMessages = injectPrefill(trimLastUserMessage(stripSummaryOpeners(truncateMessages(messages))));
      setCache(cacheKey, processedMessages.slice(0, -1));
    }

    const processedChars = JSON.stringify(processedMessages).length;
    if (processedMessages.length < messages.length) {
      console.log("Sending", processedMessages.length, "messages,", processedChars, "chars to NVIDIA");
    }

    const response = await makeNvidiaRequest(processedMessages, temperature, max_tokens, stream, 0);

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      response.data.pipe(res);
      response.data.on("end", function() { console.log("Stream completed"); });
      response.data.on("error", function(err) { console.error("Stream error:", err); res.end(); });
      return;
    }

    const reply = (
      response.data &&
      response.data.choices &&
      response.data.choices[0] &&
      response.data.choices[0].message &&
      response.data.choices[0].message.content
    ) || "";

    const openaiResponse = {
      id: (response.data && response.data.id) || ("chatcmpl-" + Date.now()),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model || "gpt-3.5-turbo",
      system_fingerprint: null,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: reply || " " },
          logprobs: null,
          finish_reason: (
            response.data &&
            response.data.choices &&
            response.data.choices[0] &&
            response.data.choices[0].finish_reason
          ) || "stop"
        }
      ],
      usage: (response.data && response.data.usage && response.data.usage.total_tokens > 0) ? response.data.usage : {
        prompt_tokens: 100,
        completion_tokens: 200,
        total_tokens: 300
      }
    };

    res.json(openaiResponse);
    console.log("Response sent -", reply.length, "chars, model:", currentModel);

  } catch (error) {
    console.error("ALL ATTEMPTS FAILED");
    console.error("ERROR:", error.message);
    console.error("NVIDIA STATUS:", error.response ? error.response.status : "unknown");
    console.error("NVIDIA DATA:", error.response ? JSON.stringify(error.response.data) : "none");

    if (!error.response || !error.response.data) {
      return res.status(503).json({
        error: { message: "All models temporarily unavailable", type: "service_unavailable", code: 503 }
      });
    }

    if (error.response && error.response.status === 429) {
      return res.status(429).json({
        error: { message: "Rate limit exceeded. Please wait a few minutes.", type: "rate_limit_error", code: 429 }
      });
    }

    res.status(error.response ? error.response.status : 500).json({
      error: error.response ? error.response.data : {
        message: error.message || "Unknown error occurred",
        type: "invalid_request_error"
      }
    });
  }
});

app.post("/v1/chat/completions/", function(req, res, next) {
  req.url = "/v1/chat/completions";
  app.handle(req, res, next);
});

app.post("/chat/completions", function(req, res, next) {
  req.url = "/v1/chat/completions";
  app.handle(req, res, next);
});

app.post("/", async function(req, res) {
  recordHit(req);
  if (req.body && req.body.messages) {
    req.url = "/v1/chat/completions";
    return app.handle(req, res);
  }
  res.type("text").send("POST received");
});

app.use(function(req, res) {
  recordHit(req);
  console.log("404 - Route not found:", req.method, req.path);
  res.status(404).json({
    error: { message: "Route not found", method: req.method, path: req.path }
  });
});

app.listen(PORT, function() {
  console.log("OpenAI to NVIDIA NIM Proxy running on port", PORT);
  console.log("Primary Model: deepseek-ai/deepseek-v3.2");
  console.log("Fallback Order: r1-distill-32b -> r1-distill-70b -> r1 -> v3.1-terminus");
  console.log("API Key:", API_KEY ? "Loaded" : "Missing");
  console.log("Streaming: ENABLED by default");
  console.log("Context Cache: ENABLED");
  console.log("Exponential Backoff: ENABLED");
});
