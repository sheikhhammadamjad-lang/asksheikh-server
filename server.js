const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
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
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
const STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONVERSATIONS_TABLE = process.env.AZURE_CONVERSATIONS_TABLE || 'AskSheikhConversations';
const FEEDBACK_TABLE = process.env.AZURE_FEEDBACK_TABLE || 'AskSheikhFeedback';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;

let cachedToken = null;
let tokenExpiry = 0;
let storageConfig = null;

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

function getStorageConfig() {
  if (storageConfig !== null) return storageConfig;
  if (!STORAGE_CONNECTION_STRING) {
    storageConfig = false;
    return storageConfig;
  }

  const parts = Object.fromEntries(
    STORAGE_CONNECTION_STRING.split(';')
      .filter(Boolean)
      .map(part => {
        const index = part.indexOf('=');
        return [part.slice(0, index), part.slice(index + 1)];
      })
  );

  const accountName = parts.AccountName;
  const accountKey = parts.AccountKey;
  const endpoint = (parts.TableEndpoint || `https://${accountName}.table.core.windows.net`).replace(/\/$/, '');
  storageConfig = accountName && accountKey ? { accountName, accountKey, endpoint } : false;
  return storageConfig;
}

function tableStorageHeaders(method, tableName, body = '', resourcePath = tableName) {
  const config = getStorageConfig();
  const date = new Date().toUTCString();
  const contentType = method === 'GET' ? '' : 'application/json';
  const resource = `/${config.accountName}/${resourcePath}`;
  const stringToSign = [method, '', contentType, date, resource].join('\n');
  const signature = crypto
    .createHmac('sha256', Buffer.from(config.accountKey, 'base64'))
    .update(stringToSign, 'utf8')
    .digest('base64');

  const headers = {
    Authorization: `SharedKey ${config.accountName}:${signature}`,
    Accept: 'application/json;odata=nometadata',
    Date: date,
    'x-ms-version': '2019-02-02'
  };

  if (contentType) headers['Content-Type'] = contentType;
  if (body) headers['Content-Length'] = Buffer.byteLength(body);
  return headers;
}

async function insertTableEntity(tableName, entity) {
  const config = getStorageConfig();
  if (!config) return false;

  const fetch = (await import('node-fetch')).default;
  const body = JSON.stringify(entity);
  const res = await fetch(`${config.endpoint}/${tableName}`, {
    method: 'POST',
    headers: tableStorageHeaders('POST', tableName, body),
    body
  });

  if (!res.ok) {
    throw new Error(`Azure Table insert failed: ${res.status} ${await res.text()}`);
  }

  return true;
}

async function queryTableEntities(tableName, options = {}) {
  const config = getStorageConfig();
  if (!config) return [];

  const fetch = (await import('node-fetch')).default;
  const params = new URLSearchParams();
  params.set('$top', String(options.top || 500));

  const res = await fetch(`${config.endpoint}/${tableName}()?${params.toString()}`, {
    method: 'GET',
    headers: tableStorageHeaders('GET', tableName, '', `${tableName}()`)
  });

  if (!res.ok) {
    throw new Error(`Azure Table query failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return Array.isArray(data.value) ? data.value : [];
}

function karachiDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function latestFeedbackByConversation(feedbackRows) {
  const map = new Map();
  for (const row of feedbackRows) {
    if (!row.conversationId) continue;
    const existing = map.get(row.conversationId);
    if (!existing || new Date(row.createdAt) > new Date(existing.createdAt)) {
      map.set(row.conversationId, row);
    }
  }
  return map;
}

function dashboardSummary(conversationRows, feedbackRows) {
  const today = karachiDateKey();
  const sortedConversations = [...conversationRows].sort((a, b) => {
    return new Date(b.createdAt || b.Timestamp || 0) - new Date(a.createdAt || a.Timestamp || 0);
  });
  const feedbackMap = latestFeedbackByConversation(feedbackRows);
  const ratedConversations = sortedConversations.filter(row => feedbackMap.has(row.RowKey));
  const thumbsUp = ratedConversations.filter(row => feedbackMap.get(row.RowKey).rating === 'up').length;
  const thumbsDown = ratedConversations.filter(row => feedbackMap.get(row.RowKey).rating === 'down').length;
  const todaysQuestions = sortedConversations.filter(row => {
    return row.createdAt && karachiDateKey(row.createdAt) === today;
  }).length;
  const positiveRate = ratedConversations.length
    ? Math.round((thumbsUp / ratedConversations.length) * 100)
    : 0;

  const formatRow = row => {
    const feedback = feedbackMap.get(row.RowKey);
    return {
      id: row.RowKey,
      createdAt: row.createdAt || row.Timestamp || '',
      question: row.userMessage || '',
      answer: row.assistantReply || '',
      rating: feedback?.rating || '',
      feedback: feedback?.feedback || '',
      mode: row.mode || '',
      agentVersion: row.agentVersion || ''
    };
  };

  return {
    generatedAt: new Date().toISOString(),
    stats: {
      totalQuestions: sortedConversations.length,
      todaysQuestions,
      ratedAnswers: ratedConversations.length,
      thumbsUp,
      thumbsDown,
      positiveRate
    },
    recent: sortedConversations.slice(0, 100).map(formatRow),
    needsReview: sortedConversations
      .filter(row => feedbackMap.get(row.RowKey)?.rating === 'down')
      .slice(0, 50)
      .map(formatRow)
  };
}

async function logConversation(entry) {
  try {
    const createdAt = new Date().toISOString();
    await insertTableEntity(CONVERSATIONS_TABLE, {
      PartitionKey: createdAt.slice(0, 10),
      RowKey: entry.conversationId,
      createdAt,
      userMessage: entry.userMessage,
      assistantReply: entry.assistantReply,
      messagesJson: JSON.stringify(entry.messages || []),
      mode: entry.mode,
      agentName: entry.agentName,
      agentVersion: entry.agentVersion,
      responseId: entry.responseId
    });
  } catch (err) {
    console.error('Azure conversation log failed:', err.message);
  }

  await appendJsonLog('conversations.jsonl', entry);
}

async function logFeedback(entry) {
  try {
    const createdAt = new Date().toISOString();
    await insertTableEntity(FEEDBACK_TABLE, {
      PartitionKey: createdAt.slice(0, 10),
      RowKey: crypto.randomUUID(),
      createdAt,
      conversationId: entry.conversationId,
      rating: entry.rating,
      feedback: entry.feedback || '',
      userAgent: entry.userAgent || '',
      ip: entry.ip || ''
    });
  } catch (err) {
    console.error('Azure feedback log failed:', err.message);
  }

  await appendJsonLog('feedback.jsonl', entry);
}

function cleanReply(text) {
  return (text || '').replace(/【[^】]*】/g, '').trim();
}

function extractResponseText(response) {
  if (response.output_text) return cleanReply(response.output_text);
  if (response.choices?.[0]?.message?.content) {
    return cleanReply(response.choices[0].message.content);
  }

  let reply = '';
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' || content.type === 'text') {
        if (typeof content.text === 'string') reply += content.text;
        else if (content.text?.value) reply += content.text.value;
        else if (typeof content.value === 'string') reply += content.value;
      }
    }
  }

  return cleanReply(reply);
}

function conversationInput(messages) {
  return messages
    .slice(-10)
    .filter(message => message && message.content)
    .map(message => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: String(message.content)
    }));
}

async function callFoundryAgent(messages) {
  const result = await callFoundryAgentOnce(messages);
  if (result.reply) return result;

  const lastMessage = messages[messages.length - 1];
  console.error('Empty Foundry response. Retrying with latest message only.');
  return callFoundryAgentOnce([lastMessage]);
}

async function callFoundryAgentOnce(messages) {
  const fetch = (await import('node-fetch')).default;
  const token = await getToken();
  const headers = authHeaders(token);
  const responseRes = await fetch(`${FOUNDRY_BASE}/openai/v1/responses`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      input: conversationInput(messages),
      agent_reference: {
        name: AGENT_NAME,
        type: 'agent_reference',
        version: AGENT_VERSION
      }
    })
  });
  if (!responseRes.ok) throw new Error(`Foundry response failed: ${await responseRes.text()}`);
  let data = await responseRes.json();

  let attempts = 0;
  while (['queued', 'in_progress', 'requires_action'].includes(data.status) && attempts < 60) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const pollRes = await fetch(`${FOUNDRY_BASE}/openai/v1/responses/${data.id}`, {
      headers
    });
    if (!pollRes.ok) throw new Error(`Foundry response poll failed: ${await pollRes.text()}`);
    data = await pollRes.json();
    attempts++;
  }

  if (data.status && data.status !== 'completed') {
    console.error('Incomplete Foundry response:', JSON.stringify(data).slice(0, 2000));
    throw new Error(`Foundry response did not complete: ${data.status}`);
  }

  const reply = extractResponseText(data);
  if (!reply) console.error('Empty Foundry response:', JSON.stringify(data).slice(0, 2000));

  return {
    reply,
    responseId: data.id
  };
}

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

function requireDashboardPassword(req, res, next) {
  if (!DASHBOARD_PASSWORD) {
    return res.status(503).json({ error: 'Dashboard password is not configured' });
  }

  const suppliedPassword = req.get('x-dashboard-password') || req.query.password;
  if (suppliedPassword !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/dashboard-data', requireDashboardPassword, async (req, res) => {
  try {
    const [conversations, feedback] = await Promise.all([
      queryTableEntities(CONVERSATIONS_TABLE, { top: 500 }),
      queryTableEntities(FEEDBACK_TABLE, { top: 500 })
    ]);
    res.json(dashboardSummary(conversations, feedback));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const userMessage = messages[messages.length - 1].content;
    const result = await callFoundryAgent(messages);
    if (!result.reply) throw new Error('Foundry agent returned an empty response');

    const conversationId = crypto.randomUUID();
    await logConversation({
      conversationId,
      userMessage,
      messages,
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
        conversation_id: conversationId,
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

app.post('/feedback', async (req, res) => {
  try {
    const { conversationId, rating, feedback } = req.body;
    if (!conversationId || !['up', 'down'].includes(rating)) {
      return res.status(400).json({ error: 'conversationId and rating are required' });
    }

    await logFeedback({
      conversationId,
      rating,
      feedback: feedback || '',
      userAgent: req.get('user-agent') || '',
      ip: req.ip
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`Running on ${PORT}`));
