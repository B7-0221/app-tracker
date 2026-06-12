const express = require('express');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 简单的内存存储（重启会清空，够用了）
let records = [];

// 快捷指令调用这个接口，上报当前打开的App
app.post('/report', (req, res) => {
  const appName = req.body.app || req.query.app;
  if (!appName) {
    return res.status(400).json({ error: 'missing app name' });
  }
  const record = {
    app: appName,
    time: new Date().toISOString()
  };
  records.push(record);
  // 只保留最近200条
  if (records.length > 200) records = records.slice(-200);
  console.log('收到上报:', record);
  res.json({ ok: true, record });
});

// 查询最近的记录
app.get('/recent', (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  res.json({ records: records.slice(-limit).reverse() });
});

// MCP 工具会调用这个接口来获取当前/最近使用的App
app.get('/current', (req, res) => {
  if (records.length === 0) {
    return res.json({ app: null, time: null, message: '还没有记录' });
  }
  const latest = records[records.length - 1];
  res.json(latest);
});

// 健康检查
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'App Tracker Server is running', recordCount: records.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
