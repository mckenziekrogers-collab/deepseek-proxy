// ============================================================================
// OpenAI to NVIDIA NIM Proxy (Long Chat + Peak Hour Optimized)
// Optimized for lengthy conversations and automatic DeepSeek model fallback
// ============================================================================

const express = require(“express”);
const cors = require(“cors”);
const axios = require(“axios”);

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================================
// MIDDLEWARE CONFIGURATION
// ============================================================================

app.use(cors({
origin: ‘*’,
methods: [‘GET’, ‘POST’, ‘OPTIONS’],
allowedHeaders: [‘Content-Type’, ‘Authorization’],
credentials: true
}));

app.use(express.json({ limit: “100mb” })); // Support EXTREMELY long chat histories (10k+ messages)

// ============================================================================
// API CONFIGURATION
// ============================================================================

const NIM_API_BASE = “https://integrate.api.nvidia.com/v1”;
const API_KEY = process.env.NIM_API_KEY;
const PRIMARY_MODEL = process.env.NIM_MODEL || “deepseek-ai/deepseek-v3.2”; // Changed back to V3.2

// Fallback models - V3.1 first, then others
const FALLBACK_MODELS = [
“deepseek-ai/deepseek-v3.1”,                  // First fallback
“deepseek-ai/deepseek-r1-distill-qwen-32b”,   // Distilled version (faster)
“deepseek-ai/deepseek-r1-distill-qwen-14b”,   // Even smaller/faster
“deepseek-ai/deepseek-v3.1-terminus”          // Alternative V3.1
];

const STRICT_MODE = false; // Set to true to disable fallbacks

// ============================================================================
// CONVERSATION TRUNCATION SETTINGS
// ============================================================================

// Adaptive truncation - optimized for speed
const ENABLE_SMART_TRUNCATION = true;
const TRUNCATION_TIERS = {
// conversations under 100 messages: send everything
small: { threshold: 100, keep: 100, keepFirst: 0 },

// 100-300 messages: send 120 most important
medium: { threshold: 300, keep: 120, keepFirst: 10 },

// 300-1000 messages: send 150 most important  
large: { threshold: 1000, keep: 150, keepFirst: 15 },

// 1000+ messages: send 180 most important (faster!)
huge: { threshold: Infinity, keep: 180, keepFirst: 20 }
};

// ============================================================================
// STATE TRACKING
// ============================================================================

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
console.log(“🔵 HIT:”, lastHit);
}

// ============================================================================
// INFORMATION ENDPOINTS
// ============================================================================

// Root endpoint
app.get(”/”, (req, res) => {
recordHit(req);
res.type(“text”).send(“✅ Proxy running! Try /health or POST to /v1/chat/completions”);
});

// Health check endpoint
app.get(”/health”, (req, res) => {
recordHit(req);
res.json({
status: “ok”,
service: “OpenAI to NVIDIA NIM Proxy”,
primaryModel: PRIMARY_MODEL,
currentModel: currentModel,
failedAttempts: failedAttempts,
fallbackModels: FALLBACK_MODELS.length,
hasNimKey: !!API_KEY
});
});

// Whoami debug endpoint
app.get(”/whoami”, (req, res) => {
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

// Upstream models endpoint - shows all available NVIDIA models
app.get(”/upstream/models”, async (req, res) => {
recordHit(req);

try {
if (!API_KEY) {
return res.status(500).json({
error: { message: “Missing NIM_API_KEY” }
});
}

```
const response = await axios.get(`${NIM_API_BASE}/models`, {
  headers: { Authorization: `Bearer ${API_KEY}` },
  timeout: 60000,
});

res.json(response.data);
```

} catch (error) {
res.status(error.response?.status || 500).json(
error.response?.data || { message: error.message }
);
}
});

// v1 base route
app.get(”/v1”, (req, res) => {
recordHit(req);
res.json({
status: “ok”,
message: “OpenAI-compatible API v1”,
endpoints: [”/v1/models”, “/v1/chat/completions”]
});
});

// OpenAI-style model list
app.get(”/v1/models”, (req, res) => {
recordHit(req);
res.json({
object: “list”,
data: [
{
id: “gpt-4”,
object: “model”,
created: Date.now(),
owned_by: “proxy”
},
{
id: “gpt-4o”,
object: “model”,
created: Date.now(),
owned_by: “proxy”
},
{
id: “gpt-3.5-turbo”,
object: “model”,
created: Date.now(),
owned_by: “proxy”
},
{
id: PRIMARY_MODEL,
object: “model”,
created: Date.now(),
owned_by: “proxy”
}
],
});
});

// ============================================================================
// SMART MESSAGE TRUNCATION - Handles 10k+ message conversations
// ============================================================================

function truncateMessages(messages) {
if (!ENABLE_SMART_TRUNCATION) {
return messages;
}

// Determine which tier based on conversation length
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

// If conversation is short enough, send everything
if (messages.length <= tier.keep) {
console.log(`✅ Conversation size: ${messages.length} messages - sending all`);
return messages;
}

console.log(`⚠️ Long conversation detected: ${messages.length} messages`);
console.log(`📉 Truncating to ${tier.keep} messages (tier: ${tier.keepFirst} first + ${tier.keep - tier.keepFirst} recent)`);

// Keep first N messages (character intro, setting, etc)
const firstMessages = tier.keepFirst > 0 ? messages.slice(0, tier.keepFirst) : [];

// Keep most recent messages
const recentMessages = messages.slice(-(tier.keep - tier.keepFirst));

// Combine them
const truncated = […firstMessages, …recentMessages];

console.log(`✅ Truncated from ${messages.length} to ${truncated.length} messages`);
if (tier.keepFirst > 0) {
console.log(`   - First ${tier.keepFirst} messages (character context)`);
console.log(`   - Last ${recentMessages.length} messages (recent conversation)`);
} else {
console.log(`   - Last ${recentMessages.length} messages only`);
}

return truncated;
}

// ============================================================================
// SMART RETRY FUNCTION - Handles failures and auto-switches DeepSeek models
// ============================================================================

async function makeNvidiaRequest(messages, temperature, max_tokens, stream, attemptNum = 0) {
const modelToUse = attemptNum === 0 ? currentModel : FALLBACK_MODELS[attemptNum - 1];

// All models exhausted
if (!modelToUse) {
throw new Error(“All DeepSeek fallback models exhausted”);
}

console.log(`🎯 Attempt ${attemptNum + 1}: Using model ${modelToUse}`);

try {
const response = await axios.post(
`${NIM_API_BASE}/chat/completions`,
{
model: modelToUse,
messages: messages,
temperature: temperature,
max_tokens: max_tokens,
stream: stream
},
{
headers: {
Authorization: `Bearer ${API_KEY}`,
“Content-Type”: “application/json”
},
timeout: 600000, // 10 minutes for EXTREMELY long chats (10k+ messages)
responseType: stream ? ‘stream’ : ‘json’,
validateStatus: (status) => status < 500 // Don’t throw on 4xx
}
);

```
// Success! Reset failure counter and update current model
if (response.status === 200) {
  failedAttempts = 0;
  
  if (modelToUse !== currentModel) {
    console.log(`✅ Switched to ${modelToUse} due to better availability`);
    currentModel = modelToUse;
  }
  
  return response;
}

// 4xx errors (bad request, rate limit, model unavailable, etc)
if (response.status >= 400 && response.status < 500) {
  console.log(`⚠️ Model ${modelToUse} returned ${response.status}, trying fallback...`);
  
  // Rate limit or model unavailable - try next model
  if (attemptNum < FALLBACK_MODELS.length) {
    failedAttempts++;
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 sec
    return makeNvidiaRequest(messages, temperature, max_tokens, stream, attemptNum + 1);
  }
  
  // All attempts failed
  throw { response };
}

throw { response };
```

} catch (error) {
// Network errors, timeouts, 5xx errors
console.log(`❌ Model ${modelToUse} failed: ${error.message}`);

```
// Try next fallback model
if (attemptNum < FALLBACK_MODELS.length) {
  failedAttempts++;
  console.log(`🔄 Trying fallback model (attempt ${attemptNum + 2})...`);
  await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 sec
  return makeNvidiaRequest(messages, temperature, max_tokens, stream, attemptNum + 1);
}

// All attempts exhausted
throw error;
```

}
}

// ============================================================================
// MAIN CHAT COMPLETION ENDPOINT
// ============================================================================

app.post(”/v1/chat/completions”, async (req, res) => {
recordHit(req);
console.log(“📨 POST /v1/chat/completions”);

try {
// Validate API key
if (!API_KEY) {
return res.status(500).json({
error: { message: “Missing NIM_API_KEY” }
});
}

```
// Parse request body
const body = req.body || {};
const messages = Array.isArray(body.messages) ? body.messages : [];
const temperature = body.temperature ?? 0.7;
const max_tokens = Math.max(body.max_tokens ?? 12000, 200); // Higher default for long responses
const stream = body.stream || false;

// Log request details
const totalChars = JSON.stringify(messages).length;
console.log(`📊 Received ${messages.length} messages, ${totalChars} chars total`);

// Smart truncation for extremely long conversations
const processedMessages = truncateMessages(messages);
const processedChars = JSON.stringify(processedMessages).length;

if (processedMessages.length < messages.length) {
  console.log(`📦 Sending ${processedMessages.length} messages, ${processedChars} chars to NVIDIA`);
}

// Make request with auto-retry and fallback
const response = await makeNvidiaRequest(processedMessages, temperature, max_tokens, stream);

// ========================================================================
// STREAMING RESPONSE
// ========================================================================

if (stream) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  response.data.pipe(res);
  
  response.data.on('end', () => {
    console.log("✅ Stream completed");
  });
  
  response.data.on('error', (err) => {
    console.error('❌ Stream error:', err);
    res.end();
  });
  
  return;
}

// ========================================================================
// NON-STREAMING RESPONSE
// ========================================================================

const reply = response.data?.choices?.[0]?.message?.content || "";

const openaiResponse = {
  id: response.data?.id || `chatcmpl-${Date.now()}`,
  object: "chat.completion",
  created: response.data?.created || Math.floor(Date.now() / 1000),
  model: body.model || "gpt-3.5-turbo",
  choices: [
    { 
      index: 0, 
      message: { 
        role: "assistant", 
        content: reply || " "
      }, 
      finish_reason: response.data?.choices?.[0]?.finish_reason || "stop" 
    }
  ],
  usage: response.data?.usage || { 
    prompt_tokens: 10, 
    completion_tokens: 50, 
    total_tokens: 60 
  }
};

res.setHeader('Content-Type', 'application/json');
res.json(openaiResponse);

console.log(`✅ Response sent (${reply.length} chars, model: ${currentModel})`);
```

} catch (error) {
// ========================================================================
// ERROR HANDLING
// ========================================================================

```
console.error("❌ ALL ATTEMPTS FAILED");
console.error("❌ ERROR:", error.message);
console.error("❌ NVIDIA STATUS:", error.response?.status);
console.error("❌ NVIDIA DATA:", JSON.stringify(error.response?.data));

// Handle undefined/empty NVIDIA responses
if (!error.response || !error.response.data) {
  console.error("❌ NVIDIA returned undefined/empty response");
  return res.status(503).json({
    error: { 
      message: "All DeepSeek models temporarily unavailable. NVIDIA API may be overloaded. Try again in 1-2 minutes.",
      type: 'service_unavailable',
      code: 503,
      suggestion: "Peak hours detected. Consider trying again later."
    }
  });
}

// Rate limit specific message
if (error.response?.status === 429) {
  return res.status(429).json({
    error: { 
      message: "Rate limit exceeded on all DeepSeek models. Please wait 5-10 minutes.",
      type: 'rate_limit_error',
      code: 429,
      suggestion: "You've hit NVIDIA's free tier limit. Wait a bit or try during off-peak hours."
    }
  });
}

// Generic error response
res.status(error.response?.status || 500).json({
  error: error.response?.data || { 
    message: error.message || "Unknown error occurred",
    type: 'invalid_request_error',
    suggestion: "Try refreshing or waiting a moment"
  }
});
```

}
});

// ============================================================================
// ALTERNATIVE ROUTES FOR COMPATIBILITY
// ============================================================================

app.post(”/v1/chat/completions/”, (req, res, next) => {
req.url = “/v1/chat/completions”;
app.handle(req, res, next);
});

app.post(”/chat/completions”, (req, res, next) => {
req.url = “/v1/chat/completions”;
app.handle(req, res, next);
});

app.post(”/”, async (req, res) => {
recordHit(req);

// If it looks like a chat request, route it
if (req.body && req.body.messages) {
req.url = “/v1/chat/completions”;
return app.handle(req, res);
}

res.type(“text”).send(“✅ POST received! For chat, use /v1/chat/completions”);
});

// ============================================================================
// CATCH-ALL 404 HANDLER
// ============================================================================

app.use((req, res) => {
recordHit(req);
console.log(“❌ 404 - Route not found:”, req.method, req.path);

res.status(404).json({
error: {
message: “Route not found”,
method: req.method,
path: req.path,
url: req.url
}
});
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

app.listen(PORT, () => {
console.log(”=”.repeat(60));
console.log(“🚀 OpenAI to NVIDIA NIM Proxy”);
console.log(”   Long Chat + Peak Hour Optimized + DeepSeek Fallback”);
console.log(”=”.repeat(60));
console.log(`📡 Port:              ${PORT}`);
console.log(`🤖 Primary Model:     ${PRIMARY_MODEL}`);
console.log(`🔄 Fallback Models:   ${FALLBACK_MODELS.length} DeepSeek models`);
console.log(`🔑 API Key:           ${API_KEY ? "✅ Loaded" : "❌ Missing"}`);
console.log(`💾 Max Request Size:  100MB (10k+ messages supported)`);
console.log(`⏱️  Request Timeout:   10 minutes`);
console.log(`📉 Smart Truncation:  ${ENABLE_SMART_TRUNCATION ? "ON (Adaptive)" : "OFF"}`);
console.log(`🌐 Health Check:      http://localhost:${PORT}/health`);
console.log(”=”.repeat(60));
console.log(“📋 Fallback Order:”);
console.log(`   1. ${PRIMARY_MODEL} (primary)`);
FALLBACK_MODELS.forEach((model, i) => {
console.log(`   ${i + 2}. ${model}`);
});
console.log(”=”.repeat(60));
});
