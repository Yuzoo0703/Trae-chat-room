const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const app = express();
app.use(express.static('public'));
app.get('/health', (req, res) => {
  res.json({ ok: true });
});
app.use(express.json());

const dataDir = path.join(__dirname, 'data');
const usersFile = path.join(dataDir, 'users.json');
const legacyFriendsFile = path.join(dataDir, 'friends.json');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(usersFile)) fs.writeFileSync(usersFile, JSON.stringify({ users: {} }, null, 2));
// 朋友与消息统一保存在 users.json 的每个用户对象中

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function getUsers() { return readJson(usersFile) || { users: {} }; }
function saveUsers(u) { writeJson(usersFile, u); }

function ensureUserDefaults(info) {
  if (!info) return { username: '', passwordHash: '', friends: [], inbox: [], oneTime: [] };
  if (!Array.isArray(info.friends)) info.friends = [];
  if (!Array.isArray(info.inbox)) info.inbox = [];
  if (!Array.isArray(info.oneTime)) info.oneTime = [];
  return info;
}

// 迁移旧版好友存储到 users.json（一次性，保留原文件不再使用）
(function migrateLegacyFriends() {
  try {
    if (!fs.existsSync(legacyFriendsFile)) return;
    const legacy = readJson(legacyFriendsFile) || {};
    const u = getUsers();
    let changed = false;
    for (const [uid, list] of Object.entries(legacy)) {
      const info = ensureUserDefaults(u.users[uid] || { username: '', passwordHash: '' });
      const set = new Set(info.friends || []);
      (list || []).forEach(fid => set.add(fid));
      info.friends = Array.from(set);
      u.users[uid] = info;
      changed = true;
    }
    if (changed) saveUsers(u);
  } catch (_) {}
})();

const ADMIN_USER = process.env.ADMIN_USER || 'root';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';
const adminSessions = new Set();
function isAdminAuthorized(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return !!(m && adminSessions.has(m[1]));
}

app.post('/api/admin/login', (req, res) => {
  const username = String((req.body && req.body.username) || '').trim();
  const password = String((req.body && req.body.password) || '');
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = genId(24);
    adminSessions.add(token);
    res.json({ token });
    return;
  }
  res.status(401).json({ error: '管理员用户名或密码错误' });
});

app.get('/api/admin/users', (req, res) => {
  if (!isAdminAuthorized(req)) { res.status(403).json({ error: '未授权' }); return; }
  const u = getUsers();
  res.json({ users: Object.entries(u.users).map(([id, v]) => ({ userId: id, username: v.username })) });
});

app.delete('/api/admin/users/:userId', (req, res) => {
  if (!isAdminAuthorized(req)) { res.status(403).json({ error: '未授权' }); return; }
  const { userId } = req.params;
  const u = getUsers();
  if (!u.users[userId]) { res.status(404).json({ error: '用户不存在' }); return; }
  // 清除好友关系并删除用户
  for (const [id, info] of Object.entries(u.users)) {
    if (id === userId) continue;
    const inf = ensureUserDefaults(info);
    inf.friends = (inf.friends || []).filter(x => x !== userId);
    u.users[id] = inf;
  }
  delete u.users[userId];
  saveUsers(u);
  // 断开在线连接
  const ws = socketsByUser.get(userId);
  if (ws) { try { ws.close(); } catch (_) {} }
  socketsByUser.delete(userId);
  friends.delete(userId);
  res.json({ ok: true });
});

app.post('/api/admin/wipe', (req, res) => {
  if (!isAdminAuthorized(req)) { res.status(403).json({ error: '未授权' }); return; }
  // 清空文件
  saveUsers({ users: {} });
  // 清空内存与连接
  for (const ws of socketsByUser.values()) { try { ws.close(); } catch (_) {} }
  socketsByUser.clear();
  userBySocket.clear();
  friends.clear();
  oneTimeStore.clear();
  res.json({ ok: true });
});

app.get('/api/search_users', (req, res) => {
  const q = String(req.query.query || '').trim().toLowerCase();
  const u = getUsers();
  const results = Object.entries(u.users)
    .filter(([, v]) => v.username && v.username.toLowerCase().includes(q))
    .map(([id, v]) => ({ userId: id, username: v.username }));
  res.json({ results });
});

app.post('/api/register', (req, res) => {
  const username = String((req.body && req.body.username) || '').trim();
  const password = String((req.body && req.body.password) || '');
  if (!username || username.length < 2 || username.length > 32) {
    res.status(400).json({ error: '用户名长度需在2-32之间' });
    return;
  }
  if (!password || password.length < 6) {
    res.status(400).json({ error: '密码长度至少6位' });
    return;
  }
  const u = getUsers();
  const existingId = Object.keys(u.users).find(id => u.users[id].username === username);
  if (existingId) {
    const info = u.users[existingId];
    if (!info.passwordHash) {
      const passwordHash = bcrypt.hashSync(password, 10);
      u.users[existingId] = { username, passwordHash };
      saveUsers(u);
      res.json({ userId: existingId, username });
      return;
    }
    res.status(400).json({ error: '用户名已存在' });
    return;
  }
  const userId = genId(10);
  const passwordHash = bcrypt.hashSync(password, 10);
  u.users[userId] = { username, passwordHash, friends: [], inbox: [], oneTime: [] };
  saveUsers(u);
  res.json({ userId, username });
});

app.post('/api/login', (req, res) => {
  const username = String((req.body && req.body.username) || '').trim();
  const password = String((req.body && req.body.password) || '');
  const u = getUsers();
  const entry = Object.entries(u.users).find(([, v]) => v.username === username);
  if (!entry) {
    res.status(400).json({ error: '用户名或密码错误' });
    return;
  }
  const [userId, info] = entry;
  if (!info.passwordHash || !bcrypt.compareSync(password, info.passwordHash)) {
    res.status(400).json({ error: '用户名或密码错误' });
    return;
  }
  res.json({ ok: true, userId, username });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function genId(len = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

const socketsByUser = new Map();
const userBySocket = new Map();
const friends = new Map();
const oneTimeStore = new Map();

function send(ws, type, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

function broadcastTo(userId, type, payload) {
  const ws = socketsByUser.get(userId);
  if (ws) send(ws, type, payload);
}

wss.on('connection', (ws, req) => {
  const u = getUsers();
  const url = new URL(req.url, 'http://localhost');
  const qUserId = String(url.searchParams.get('userId') || '').trim();
  const qUsername = String(url.searchParams.get('username') || '').trim();
  let userId = '';
  if (qUserId && u.users[qUserId]) {
    userId = qUserId;
  } else if (qUsername) {
    const entry = Object.entries(u.users).find(([, v]) => v.username === qUsername);
    if (entry) userId = entry[0];
  }
  if (!userId) {
    send(ws, 'error', { message: '未登录或用户不存在，请先注册/登录' });
    ws.close();
    return;
  }
  socketsByUser.set(userId, ws);
  userBySocket.set(ws, userId);
  const info = ensureUserDefaults(u.users[userId]);
  u.users[userId] = info;
  saveUsers(u);
  if (!friends.has(userId)) friends.set(userId, new Set(info.friends || []));
  send(ws, 'user_info', { userId, username: u.users[userId].username });

  // 推送离线消息并清空收件箱
  if (Array.isArray(info.inbox) && info.inbox.length > 0) {
    for (const m of info.inbox) {
      broadcastTo(userId, 'message', { from: m.from, to: userId, content: m.content, timestamp: m.timestamp });
    }
    info.inbox = [];
    u.users[userId] = info;
    saveUsers(u);
  }
  // 推送一次性消息占位（仅推送一次）
  if (Array.isArray(info.oneTime) && info.oneTime.length > 0) {
    let changed = false;
    for (const ot of info.oneTime) {
      if (!ot.deliveredStub) {
        broadcastTo(userId, 'one_time_stub', { messageId: ot.id, from: ot.from });
        ot.deliveredStub = true;
        changed = true;
      }
    }
    if (changed) { u.users[userId] = info; saveUsers(u); }
  }

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (_) {
      return;
    }
    const { type, payload } = msg;
    const from = userBySocket.get(ws);

    if (type === 'add_friend') {
      const { friendId, friendName } = payload || {};
      const u = getUsers();
      let targetId = friendId;
      if ((!targetId || !u.users[targetId]) && friendName) {
        const entry = Object.entries(u.users).find(([, v]) => v.username === friendName);
        if (entry) targetId = entry[0];
      }
      if (!targetId || !u.users[targetId]) {
        send(ws, 'error', { message: '好友不存在' });
        return;
      }
      friends.get(from).add(targetId);
      if (!friends.has(targetId)) friends.set(targetId, new Set());
      friends.get(targetId).add(from);
      const U = getUsers();
      const fromInfo = ensureUserDefaults(U.users[from]);
      const toInfo = ensureUserDefaults(U.users[targetId]);
      if (!fromInfo.friends.includes(targetId)) fromInfo.friends.push(targetId);
      if (!toInfo.friends.includes(from)) toInfo.friends.push(from);
      U.users[from] = fromInfo; U.users[targetId] = toInfo; saveUsers(U);
      const detailsFrom = Array.from(friends.get(from)).map(id => ({ userId: id, username: u.users[id]?.username }));
      const detailsTarget = Array.from(friends.get(targetId)).map(id => ({ userId: id, username: u.users[id]?.username }));
      send(ws, 'friends_update', { friends: detailsFrom });
      broadcastTo(targetId, 'friends_update', { friends: detailsTarget });
      return;
    }

    if (type === 'get_friends') {
      const U = getUsers();
      const fromInfo = ensureUserDefaults(U.users[from]);
      const list = Array.from(new Set(fromInfo.friends || [])).map(id => ({ userId: id, username: U.users[id]?.username }));
      send(ws, 'friends_update', { friends: list });
      return;
    }

    if (type === 'send_message') {
      const { to, content, oneTime, ttlSec } = payload || {};
      if (!to || !content || typeof content !== 'string') {
        send(ws, 'error', { message: '消息参数不完整' });
        return;
      }
      const timestamp = Date.now();
      if (!oneTime) {
        if (socketsByUser.has(to)) {
          broadcastTo(to, 'message', { from, to, content, timestamp });
        } else {
          const U = getUsers();
          const toInfo = ensureUserDefaults(U.users[to]);
          toInfo.inbox.push({ from, content, timestamp });
          U.users[to] = toInfo; saveUsers(U);
        }
        send(ws, 'message_sent', { to, content, timestamp });
        return;
      }
      const ttl = Math.max(1, Number(ttlSec || 30));
      const messageId = genId(12);
      if (socketsByUser.has(to)) {
        oneTimeStore.set(messageId, { from, to, content, ttlSec: ttl, timer: null, revealed: false, revealAt: null });
        broadcastTo(to, 'one_time_stub', { messageId, from });
      } else {
        const U = getUsers();
        const toInfo = ensureUserDefaults(U.users[to]);
        toInfo.oneTime.push({ id: messageId, from, to, content, ttlSec: ttl, deliveredStub: false, revealed: false });
        U.users[to] = toInfo; saveUsers(U);
      }
      send(ws, 'one_time_sent', { messageId, to });
      return;
    }

    if (type === 'request_reveal') {
      const { messageId } = payload || {};
      let rec = oneTimeStore.get(messageId);
      if (!rec) {
        const U = getUsers();
        const info = ensureUserDefaults(U.users[from]);
        const found = info.oneTime.find(m => m.id === messageId);
        if (found) {
          rec = { from: found.from, to: from, content: found.content, ttlSec: found.ttlSec, timer: null, revealed: false, revealAt: null, persistent: true };
        }
      }
      if (!rec || rec.to !== from) {
        send(ws, 'error', { message: '消息不存在或无权查看' });
        return;
      }
      if (!rec.revealed) {
        rec.revealed = true;
        rec.revealAt = Date.now();
        broadcastTo(from, 'one_time_reveal', { messageId, from: rec.from, content: rec.content, ttlSec: rec.ttlSec });
        rec.timer = setTimeout(() => {
          const r = oneTimeStore.get(messageId);
          if (r) {
            oneTimeStore.delete(messageId);
            broadcastTo(r.to, 'one_time_destroyed', { messageId, reason: 'timeout' });
            broadcastTo(r.from, 'one_time_destroyed', { messageId, reason: 'timeout' });
          } else {
            const U2 = getUsers();
            const info2 = ensureUserDefaults(U2.users[from]);
            info2.oneTime = (info2.oneTime || []).filter(m => m.id !== messageId);
            U2.users[from] = info2; saveUsers(U2);
            broadcastTo(from, 'one_time_destroyed', { messageId, reason: 'timeout' });
            broadcastTo(rec.from, 'one_time_destroyed', { messageId, reason: 'timeout' });
          }
        }, rec.ttlSec * 1000);
        if (!oneTimeStore.has(messageId)) {
          oneTimeStore.set(messageId, rec);
        }
      }
      return;
    }

    if (type === 'ping') {
      send(ws, 'pong', {});
      return;
    }
  });

  ws.on('close', () => {
    const uid = userBySocket.get(ws);
    userBySocket.delete(ws);
    socketsByUser.delete(uid);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
});
