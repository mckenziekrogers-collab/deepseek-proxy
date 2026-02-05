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
  "deepseek-ai/deepseek-v3.1",
  "deepseek-ai/deepseek-v3.2",
  "deepseek-ai/deepseek-v3.1-terminus",
  "deepseek-ai/deepseek-r1-distill-qwen-32b"
];

const ENABLE_SMART_TRUNCATION = true;
const TRUNCATION_TIERS = {
  small: { threshold: 100, keep: 100, keepFirst: 0 },
  medium: { threshold: 300, keep: 120, keepFirst: 10 },
  large: { threshold: 1000, keep: 150, keepFirst: 15 },
  huge: { threshold: Infinity, keep: 180, keepFirst: 20 }
};

let lastHit = null;
let failedAttempts = 0;
let currentModel = PRIMARY_MODEL;

function recordHit(req) {
  lastHit = {
    time: new Date().toISOString(),
    method: req.method,
    path: req.path,
    url: req.url,
  };
  console.log("HIT:", lastHit);
}

app.get("/", (req, res) => {
  recordHit(req);
  res.type("text").send("Proxy running");
});

app.get("/health", (req, res) => {
  recordHit(req);
  res.json({ 
    status: "ok", 
    service: "OpenAI to NVIDIA NIM Proxy",
    primaryModel: PRIMARY_MODEL,
    currentModel: currentModel,
    failedAttempts: failedAttempts,
    fallbackModels: FALLBACK_MODELS.length,
    hasNimKey: !!API_KEY,
    antiAnalyzing: true
  });
});

app.get("/whoami", (req, res) => {
  recordHit(req);
  res.json({ 
    lastHit, 
    primaryModel: PRIMARY_MODEL,
    currentModel: currentModel,
    failedAttempts: failedAttempts,
    fallbackModels: FALLBACK_MODELS,
    hasNimKey: !!API_KEY
  });
});

app.get("/upstream/models", async (req, res) => {
  recordHit(req);
  try {
    if (!API_KEY) {
      return res.status(500).json({ error: { message: "Missing NIM_API_KEY" } });
    }
    const r = await axios.get(NIM_API_BASE + "/models", {
      headers: { Authorization: "Bearer " + API_KEY },
      timeout: 60000,
    });
    res.json(r.data);
  } catch (e) {
    res.status(e.response?.status || 500).json(e.response?.data || { message: e.message });
  }
});

app.get("/v1", (req, res) => {
  recordHit(req);
  res.json({ 
    status: "ok",
    message: "OpenAI-compatible API v1",
    endpoints: ["/v1/models", "/v1/chat/completions"]
  });
});

app.get("/v1/models", (req, res) => {
  recordHit(req);
  res.json({
    object: "list",
    data: [
      { id: "gpt-4", object: "model", created: Date.now(), owned_by: "proxy" },
      { id: "gpt-4o", object: "model", created: Date.now(), owned_by: "proxy" },
      { id: "gpt-3.5-turbo", object: "model", created: Date.now(), owned_by: "proxy" },
      { id: PRIMARY_MODEL, object: "model", created: Date.now(), owned_by: "proxy" }
    ],
  });
});

function truncateMessages(messages) {
  if (!ENABLE_SMART_TRUNCATION) {
    return messages;
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
    return messages;
  }

  console.log("Long conversation detected:", messages.length, "messages");
  console.log("Truncating to", tier.keep, "messages");

  const firstMessages = tier.keepFirst > 0 ? messages.slice(0, tier.keepFirst) : [];
  const recentMessages = messages.slice(-(tier.keep - tier.keepFirst));
  const truncated = [...firstMessages, ...recentMessages];
  
  console.log("Truncated from", messages.length, "to", truncated.length, "messages");
  
  return truncated;
}

async function makeNvidiaRequest(messages, temperature, max_tokens, stream, attemptNum) {
  attemptNum = attemptNum || 0;
  const modelToUse = attemptNum === 0 ? currentModel : FALLBACK_MODELS[attemptNum - 1];
  
  if (!modelToUse) {
    throw new Error("All fallback models exhausted");
  }

  console.log("Attempt", attemptNum + 1, "- Using model", modelToUse);

  try {
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
        headers: { 
          Authorization: "Bearer " + API_KEY,
          "Content-Type": "application/json"
        },
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

    if (response.status >= 400 && response.status < 500) {
      console.log("Model", modelToUse, "returned", response.status, "trying fallback");
      
      if (attemptNum < FALLBACK_MODELS.length) {
        failedAttempts++;
        await new Promise(function(resolve) { setTimeout(resolve, 1000); });
        return makeNvidiaRequest(messages, temperature, max_tokens, stream, attemptNum + 1);
      }
      
      throw { response: response };
    }

    throw { response: response };

  } catch (error) {
    console.log("Model", modelToUse, "failed:", error.message);
    
    if (attemptNum < FALLBACK_MODELS.length) {
      failedAttempts++;
      console.log("Trying fallback model");
      await new Promise(function(resolve) { setTimeout(resolve, 2000); });
      return makeNvidiaRequest(messages, temperature, max_tokens, stream, attemptNum + 1);
    }
    
    throw error;
  }
}

app.post("/v1/chat/completions", async (req, res) => {
  recordHit(req);
  console.log("POST /v1/chat/completions");
  
  try {
    if (!API_KEY) {
      return res.status(500).json({ error: { message: "Missing NIM_API_KEY" } });
    }

    const body = req.body || {};
    let messages = Array.isArray(body.messages) ? body.messages : [];
    const temperature = body.temperature !== undefined ? body.temperature : 0.7;
    const requestedMaxTokens = body.max_tokens !== undefined ? body.max_tokens : 12000;
    const max_tokens = Math.min(Math.max(requestedMaxTokens, 200), 8000);
    const stream = body.stream || false;
    
    const hasSystemMessage = messages.some(function(msg) { return msg.role === "system"; });
    if (!hasSystemMessage) {
      messages = [
        {
          role: "system",
          content: "Respond naturally and directly. Do not analyze or overthink. Answer concisely and stay in character."
        }
      ].concat(messages);
      console.log("Added anti-analyzing system message");
    }

    const totalChars = JSON.stringify(messages).length;
    console.log("Received", messages.length, "messages,", totalChars, "chars total");
    
    const processedMessages = truncateMessages(messages);
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
      
      response.data.on("end", function() {
        console.log("Stream completed");
      });
      
      response.data.on("error", function(err) {
        console.error("Stream error:", err);
        res.end();
      });
      
      return;
    }

    const reply = (response.data && response.data.choices && response.data.choices[0] && response.data.choices[0].message && response.data.choices[0].message.content) || "";
    
    const openaiResponse = {
      id: (response.data && response.data.id) || ("chatcmpl-" + Date.now()),
      object: "chat.completion",
      created: (response.data && response.data.created) || Math.floor(Date.now() / 1000),
      model: body.model || "gpt-3.5-turbo",
      choices: [
        { 
          index: 0, 
          message: { 
            role: "assistant", 
            content: reply || " "
          }, 
          finish_reason: (response.data && response.data.choices && response.data.choices[0] && response.data.choices[0].finish_reason) || "stop"
        }
      ],
      usage: (response.data && response.data.usage) || { 
        prompt_tokens: 10, 
        completion_tokens: 50, 
        total_tokens: 60 
      }
    };

    res.setHeader("Content-Type", "application/json");
    res.json(openaiResponse);
    
    console.log("Response sent -", reply.length, "chars, model:", currentModel);

  } catch (error) {
    console.error("ALL ATTEMPTS FAILED");
    console.error("ERROR:", error.message);
    console.error("NVIDIA STATUS:", error.response ? error.response.status : "unknown");
    console.error("NVIDIA DATA:", error.response ? JSON.stringify(error.response.data) : "none");
    
    if (!error.response || !error.response.data) {
      return res.status(503).json({
        error: { 
          message: "All models temporarily unavailable",
          type: "service_unavailable",
          code: 503
        }
      });
    }

    if (error.response && error.response.status === 429) {
      return res.status(429).json({
        error: { 
          message: "Rate limit exceeded. Please wait 5-10 minutes.",
          type: "rate_limit_error",
          code: 429
        }
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
    error: { 
      message: "Route not found", 
      method: req.method, 
      path: req.path
    } 
  });
});

app.listen(PORT, function() {
  console.log("OpenAI to NVIDIA NIM Proxy running on port", PORT);
  console.log("Primary Model: deepseek-ai/deepseek-v3.2");
  console.log("Fallback Order: v3.1 -> v3.2 -> v3.1-terminus -> r1-distill-32b");
  console.log("API Key:", API_KEY ? "Loaded" : "Missing");
  console.log("Anti-Analyzing: ENABLED");
});
