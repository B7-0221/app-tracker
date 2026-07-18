const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'mcp-session-id'] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── 数据存储 ────────────────────────────────────────
let appData = { currentApp: null, lastUpdate: null, history: [] };
const authCodes = new Map();
const accessTokens = new Map();
const registeredClients = new Map();

// ─── OAuth 元数据 ─────────────────────────────────────
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  const base = `https://${req.headers.host}`;
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256', 'plain']
  });
});

// ─── 动态客户端注册 ───────────────────────────────────
app.post('/oauth/register', (req, res) => {
  const client_id = crypto.randomBytes(16).toString('hex');
  const client_secret = crypto.randomBytes(32).toString('hex');
  const data = { ...req.body, client_id, client_secret };
  registeredClients.set(client_id, data);
  res.status(201).json(data);
});

// ─── OAuth 授权 ──────────────────────────────────────
app.get('/oauth/authorize', (req, res) => {
  const { redirect_uri, state, code_challenge, code_challenge_method } = req.query;
  const code = crypto.randomBytes(20).toString('hex');
  authCodes.set(code, { redirect_uri, code_challenge, code_challenge_method: code_challenge_method || 'plain' });
  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  res.redirect(url.toString());
});

// ─── OAuth Token ──────────────────────────────────────
app.post('/oauth/token', (req, res) => {
  const { grant_type, code, code_verifier } = req.body;
  if (grant_type !== 'authorization_code') return res.status(400).json({ error: 'unsupported_grant_type' });
  const stored = authCodes.get(code);
  if (!stored) return res.status(400).json({ error: 'invalid_grant' });
  if (stored.code_challenge && code_verifier) {
    let check = code_verifier;
    if (stored.code_challenge_method === 'S256') {
      check = crypto.createHash('sha256').update(code_verifier).digest('base64url');
    }
    if (check !== stored.code_challenge) { authCodes.delete(code); return res.status(400).json({ error: 'invalid_grant' }); }
  }
  authCodes.delete(code);
  const token = crypto.randomBytes(40).toString('hex');
  accessTokens.set(token, { created: Date.now() });
  res.json({ access_token: token, token_type: 'Bearer', expires_in: 86400 });
});

// ─── Token 验证 ───────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'unauthorized' });
  if (!accessTokens.has(header.slice(7))) return res.status(401).json({ error: 'invalid_token' });
  next();
}

// ─── MCP 工具处理 ─────────────────────────────────────
function handleMCP(method, params, id) {
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: '应用追踪器', version: '2.0.0' }
    }};
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: [
      { name: 'get_current_app', description: '查询湘湘当前正在使用什么应用', inputSchema: { type: 'object', properties: {} } },
      { name: 'update_current_app', description: '更新湘湘当前正在使用的应用', inputSchema: { type: 'object', properties: { app_name: { type: 'string', description: '应用名称' } }, required: ['app_name'] } },
      { name: 'get_app_history', description: '查询最近应用使用历史', inputSchema: { type: 'object', properties: {} } }
    ]}};
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    if (name === 'get_current_app') {
      const text = appData.currentApp ? `当前应用：${appData.currentApp}\n更新时间：${appData.lastUpdate}` : '暂无数据';
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
    }
    if (name === 'update_current_app') {
      const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      appData = { currentApp: args.app_name, lastUpdate: now, history: [...appData.history.slice(-49), { app: args.app_name, time: now }] };
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `已记录：${args.app_name}（${now}）` }] } };
    }
    if (name === 'get_app_history') {
      const list = appData.history.slice(-10).reverse();
      const text = list.length ? list.map(h => `${h.time}  ${h.app}`).join('\n') : '暂无历史';
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
    }
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
}

// ─── MCP Streamable HTTP 端点 ─────────────────────────
// GET：建立 SSE 流（服务器推送用）
app.get('/mcp', authMiddleware, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const hb = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => clearInterval(hb));
});

// POST：处理 JSON-RPC 消息
app.post('/mcp', authMiddleware, (req, res) => {
  const body = req.body;
  const acceptSSE = (req.headers.accept || '').includes('text/event-stream');

  // 批量请求
  if (Array.isArray(body)) {
    const results = body.map(msg => handleMCP(msg.method, msg.params, msg.id)).filter(Boolean);
    if (acceptSSE) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      results.forEach(r => res.write(`event: message\ndata: ${JSON.stringify(r)}\n\n`));
      return res.end();
    }
    return res.json(results);
  }

  // 单条请求
  const result = handleMCP(body.method, body.params, body.id);
  if (!result) return res.status(202).end();

  if (acceptSSE) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.write(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
    return res.end();
  }
  res.json(result);
});

// ─── 健康检查 ─────────────────────────────────────────
app.get('/', (req, res) => res.send('应用追踪器运行中 ✓'));

app.listen(PORT, () => console.log(`Server on port ${PORT}`));
