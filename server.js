const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── 数据 ────────────────────────────────────────────
let appData = { currentApp: null, lastUpdate: null, history: [] };
const authCodes = new Map();
const accessTokens = new Map();

// ─── OAuth 受保护资源元数据 (RFC 9728) ───────────────
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  const base = `https://${req.headers.host}`;
  res.json({
    resource: base,
    authorization_servers: [base],
    bearer_methods_supported: ['header']
  });
});

// ─── OAuth 授权服务器元数据 ───────────────────────────
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
  res.status(201).json({ ...req.body, client_id, client_secret });
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

// ─── 401 帮助函数 ─────────────────────────────────────
function unauthorized(req, res) {
  const base = `https://${req.headers.host}`;
  res.setHeader('WWW-Authenticate',
    `Bearer realm="${base}", resource_metadata="${base}/.well-known/oauth-protected-resource"`
  );
  res.status(401).json({ error: 'unauthorized' });
}

// ─── Token 验证 ───────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return unauthorized(req, res);
  if (!accessTokens.has(header.slice(7))) return unauthorized(req, res);
  next();
}

// ─── MCP 逻辑 ─────────────────────────────────────────
function handleMCP(method, params, id) {
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: '应用追踪器', version: '3.0.0' }
    }};
  }
  if (method === 'notifications/initialized' || method === 'ping') return null;

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: [
      { name: 'get_current_app', description: '查询湘湘当前使用什么应用', inputSchema: { type: 'object', properties: {} } },
      { name: 'update_current_app', description: '更新湘湘当前使用的应用', inputSchema: { type: 'object', properties: { app_name: { type: 'string' } }, required: ['app_name'] } },
      { name: 'get_app_history', description: '查看最近应用使用历史', inputSchema: { type: 'object', properties: {} } }
    ]}};
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    if (name === 'get_current_app') {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: appData.currentApp ? `当前：${appData.currentApp}（${appData.lastUpdate}）` : '暂无数据' }] } };
    }
    if (name === 'update_current_app') {
      appData = { currentApp: args.app_name, lastUpdate: now, history: [...appData.history.slice(-49), { app: args.app_name, time: now }] };
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `已记录：${args.app_name}（${now}）` }] } };
    }
    if (name === 'get_app_history') {
      const list = appData.history.slice(-10).reverse().map(h => `${h.time}  ${h.app}`).join('\n');
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: list || '暂无历史' }] } };
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
}

// ─── MCP 端点 (GET SSE + POST JSON) ──────────────────
app.get('/mcp', (req, res) => {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ') || !accessTokens.has(header.slice(7))) {
    return unauthorized(req, res);
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const hb = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => clearInterval(hb));
});

app.post('/mcp', (req, res) => {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ') || !accessTokens.has(header.slice(7))) {
    return unauthorized(req, res);
  }
  const body = req.body;
  const msgs = Array.isArray(body) ? body : [body];
  const results = msgs.map(m => handleMCP(m.method, m.params, m.id)).filter(Boolean);
  if (results.length === 0) return res.status(202).end();
  res.json(Array.isArray(body) ? results : results[0]);
});

// ─── 健康检查 ─────────────────────────────────────────
app.get('/', (req, res) => res.send('App Tracker MCP ✓'));

app.listen(PORT, () => console.log(`Server on port ${PORT}`));
