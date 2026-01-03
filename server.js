const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const API_KEY = process.env.NIM_API_KEY;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', model: 'deepseek-ai/deepseek-v3.1' });
});

app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [
      { id: 'gpt-4', object: 'model', created: Date.now(), owned_by: 'deepseek' },
      { id: 'gpt-4o', object: 'model', created: Date.now(), owned_by: 'deepseek' }
    ]
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  console.log('REQUEST RECEIVED:', req.body);
  
  try {
    const { messages, stream } = req.body;
    
    const response = await axios.post(
      'https://integrate.api.nvidia.com/v1/chat/completions',
      {
        model: 'deepseek-ai/deepseek-v3.1',
        messages: messages,
        temperature: 0.7,
        max_tokens: 2048,
        stream: stream || false
      },
      {
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json'
        },
        responseType: stream ? 'stream' : 'json'
      }
    );
    
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      response.data.pipe(res);
    } else {
      res.json({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'gpt-4',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: response.data.choices[0].message.content
          },
          finish_reason: 'stop'
        }],
        usage: response.data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      });
    }
  } catch (error) {
    console.error('ERROR:', error.response?.data || error.message);
    res.status(500).json({ error: { message: error.message } });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
