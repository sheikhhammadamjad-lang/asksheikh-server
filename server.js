const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const fs = require('fs/promises');
const path = require('path');
const app = express();

app.set('trust proxy', 1);
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());
app.use(express.static('public'));

const limiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 20,
  message: { error: 'You have reached your daily limit of 20 questions. Please come back tomorrow!' }
});
app.use('/chat', limiter);

const TENANT_ID = process.env.AZURE_TENANT_ID;
const CLIENT_ID = process.env.AZURE_CLIENT_ID;
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;
const FOUNDRY_BASE = process.env.AZURE_FOUNDRY_BASE || 'https://asksheikh1-resource.services.ai.azure.com/api/projects/asksheikh';
const AGENT_NAME = process.env.AZURE_FOUNDRY_AGENT_NAME || 'AskSheikh';
const AGENT_VERSION = process.env.AZURE_FOUNDRY_AGENT_VERSION || '16';
const LOG_DIR = path.join(__dirname, 'logs');

let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  const fetch = (await import('node-fetch')).default;
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: 'https://ai.azure.com/.default'
  });

  const res = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  if (!res.ok) throw new Error(`Token failed: ${await res.text()}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

function authHeaders(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

async function appendJsonLog(fileName, entry) {
  await fs.mkdir(LOG_DIR, { recursive: true });
  await fs.appendFile(
    path.join(LOG_DIR, fileName),
    `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`
  );
}

function cleanReply(text) {
  return (text || '').replace(/【[^】]*】/g, '').trim();
}

function extractAssistantText(assistantMsg) {
  let reply = '';
  if (assistantMsg?.content) {
    for (const item of assistantMsg.content) {
      if (item.type === 'text') reply += item.text?.value || item.text || '';
    }
  }
  return cleanReply(reply);
}

function extractResponseText(response) {
  if (response.output_text) return cleanReply(response.output_text);

  let reply = '';
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' || content.type === 'text') {
        reply += content.text || content.value || '';
      }
    }
  }

  return cleanReply(reply);
}

function conversationPrompt(messages) {
  const recent = messages.slice(-10);
  const transcript = recent.map(message => {
    const role = message.role === 'assistant' ? 'AskSheikh' : 'User';
    return `${role}: ${message.content}`;
  }).join('\n\n');

  return [
    'Continue this AskSheikh conversation. Use the agent instructions, knowledge base, and web search tools configured in Azure Foundry.',
    '',
    transcript
  ].join('\n');
}

async function callFoundryAgent(messages) {
  const fetch = (await import('node-fetch')).default;
  const token = await getToken();
  const responseRes = await fetch(`${FOUNDRY_BASE}/openai/v1/responses`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      input: conversationPrompt(messages),
      agent_reference: {
        name: AGENT_NAME,
        type: 'agent_reference',
        version: AGENT_VERSION
      }
    })
  });
  if (!responseRes.ok) throw new Error(`Foundry response failed: ${await responseRes.text()}`);
  const data = await responseRes.json();

  return {
    reply: extractResponseText(data),
    responseId: data.id
  };
}

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const userMessage = messages[messages.length - 1].content;
    const result = await callFoundryAgent(messages);

    await appendJsonLog('conversations.jsonl', {
      userMessage,
      mode: 'foundry_agent_proxy',
      assistantReply: result.reply,
      agentName: AGENT_NAME,
      agentVersion: AGENT_VERSION,
      responseId: result.responseId
    });

    console.log('User:', userMessage);
    console.log('Foundry agent:', result.reply.substring(0, 150) + '...');

    res.json({
      choices: [{ message: { content: result.reply, role: 'assistant' }, finish_reason: 'stop' }],
      metadata: {
        mode: 'foundry_agent_proxy',
        agent_name: AGENT_NAME,
        agent_version: AGENT_VERSION,
        response_id: result.responseId
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`Running on ${PORT}`));
