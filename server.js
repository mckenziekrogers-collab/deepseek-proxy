// server.js - OpenAI to NVIDIA NIM Proxy (DeepSeek V3.1 with Long Chat Support)
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: "20mb" })); // Increased for long chats

// NVIDIA NIM API configuration
const NIM_API_BASE = "https://integrate.api.nvidia.com/v1";
const API_KEY = process.env.NIM_API_KEY;
const MODEL = process.env.NIM_MODEL || "deepseek-ai/deepseek-v3.1";

// 🔥 REASONING DISPLAY TOGGLE
const SHOW_REASONING = false; // Set to true to show reasoning with <think> tags

// Request tracking
let lastHit = null;
function recordHit(req) {
  lastHit = {
    time: new Date().toISOString(),
    method: req.method,
    path: req.path,
  };
  console.log("HIT:", lastHit);
}

// Root endpoint
app.get("/", (req, res) => {
  recordHit(req);
  res.type("text").send("Proxy up. Try /health, /whoami, /upstream/models");
});

// Health check endpoint
app.get("/health", (req, res) => {
  recordHit(req);
  res.json({ 
    status: "ok", 
    service: "OpenAI to NVIDIA NIM Proxy (DeepSeek V3.1)",
    model: MODEL,
    hasNimKey: !!API_KEY,
    reasoning_display: SHOW_REASONING
  });
});

// Whoami debug endpoint
app.get("/whoami", (req, res) => {
  recordHit(req);
  res.json({ 
    lastHit, 
    model: MODEL, 
    hasNimKey: !!API_KEY,
    reasoning_display: SHOW_REASONING
  });
});

// Upstream models endpoint - shows actual NVIDIA models
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

// OpenAI-style model list for clients
app.get("/v1/models", (req, res) => {
  recordHit(req);
  res.json({
    object: "list",
    data: [
      { id: "gpt-4", object: "model", created: Date.now(), owned_by: "nvidia-deepseek-proxy" },
      { id: "gpt-4o", object: "model", created: Date.now(), owned_by: "nvidia-deepseek-proxy" },
      { id: "gpt-3.5-turbo", object: "model", created: Date.now(), owned_by: "nvidia-deepseek-proxy" },
      { id: MODEL, object: "model", created: Date.now(), owned_by: "nvidia-deepseek-proxy" }
    ],
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

// Main chat completion handler
async function handleChat(req, res) {
  recordHit(req);
  try {
    if (!API_KEY) {
      return res.status(500).json({ error: { message: "Missing NIM_API_KEY" } });
    }

    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const temperature = body.temperature ?? 0.7;
    const max_tokens = body.max_tokens ?? 8192; // Increased for long chats
    const stream = body.stream || false;

    console.log(`Processing ${messages.length} messages - Routing to: ${MODEL}`);

    const nimRequest = {
      model: MODEL,
      messages: messages,
      temperature: temperature,
      max_tokens: max_tokens,
      stream: stream
    };

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: { 
        Authorization: `Bearer ${API_KEY}`, 
        "Content-Type": "application/json" 
      },
      timeout: 120000,
      responseType: stream ? 'stream' : 'json'
    });

    if (stream) {
      // Handle streaming response with reasoning
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      let buffer = '';
      let reasoningStarted = false;
      
      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        lines.forEach(line => {
          if (line.startsWith('data: ')) {
            if (line.includes('[DONE]')) {
              res.write(line + '\n\n');
              return;
            }
            
            try {
              const data = JSON.parse(line.slice(6));
              if (data.choices?.[0]?.delta) {
                const reasoning = data.choices[0].delta.reasoning_content;
                const content = data.choices[0].delta.content;
                
                if (SHOW_REASONING) {
                  let combinedContent = '';
                  
                  if (reasoning && !reasoningStarted) {
                    combinedContent = '<think>\n' + reasoning;
                    reasoningStarted = true;
                  } else if (reasoning) {
                    combinedContent = reasoning;
                  }
                  
                  if (content && reasoningStarted) {
                    combinedContent += '\n</think>\n\n' + content;
                    reasoningStarted = false;
                  } else if (content) {
                    combinedContent += content;
                  }
                  
                  if (combinedContent) {
                    data.choices[0].delta.content = combinedContent;
                    delete data.choices[0].delta.reasoning_content;
                  }
                } else {
                  if (content) {
                    data.choices[0].delta.content = content;
                  } else {
                    data.choices[0].delta.content = '';
                  }
                  delete data.choices[0].delta.reasoning_content;
                }
              }
              res.write(`data: ${JSON.stringify(data)}\n\n`);
            } catch (e) {
              res.write(line + '\n');
            }
          }
        });
      });
      
      response.data.on('end', () => res.end());
      response.data.on('error', (err) => {
        console.error('Stream error:', err);
        res.end();
      });
    } else {
      // Non-streaming response with reasoning
      let fullContent = response.data?.choices?.[0]?.message?.content || "";
      
      if (SHOW_REASONING && response.data?.choices?.[0]?.message?.reasoning_content) {
        fullContent = '<think>\n' + response.data.choices[0].message.reasoning_content + '\n</think>\n\n' + fullContent;
      }

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
              content: fullContent 
            }, 
            finish_reason: response.data?.choices?.[0]?.finish_reason || "stop" 
          }
        ],
        usage: response.data?.usage || { 
          prompt_tokens: 0, 
          completion_tokens: 0, 
          total_tokens: 0 
        },
      });
    }
  } catch (error) {
    console.error("NVIDIA ERROR STATUS:", error.response?.status);
    console.error("NVIDIA ERROR DATA:", error.response?.data || error.message);
    
    res.status(error.response?.status || 500).json({
      error: error.response?.data || { 
        message: error.message,
        type: 'invalid_request_error'
      },
    });
  }
}

// Bulletproof POST routes (covers Janitor oddities + long chats)
app.post(
  [
    "/v1/chat/completions",
    "/v1/chat/completions/",
    "/chat/completions",
    
  ],
  handleChat
);

// Catch-all 404 so we can see what's being hit
app.use((req, res) => {
  recordHit(req);
  res.status(404).json({ 
    error: { 
      message: "Route not found", 
      method: req.method, 
      path: req.path 
    } 
  });
});

app.listen(PORT, () => {
  console.log(`OpenAI to NVIDIA NIM Proxy running on port ${PORT}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Reasoning display: ${SHOW_REASONING ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Max JSON size: 20mb (supports long chats)`);
});
