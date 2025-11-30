(() => {
  const myIdEl = document.getElementById('myId');
  const friendInput = document.getElementById('friendInput');
  const addFriendBtn = document.getElementById('addFriendBtn');
  const friendListEl = document.getElementById('friendList');
  const searchResultsEl = document.getElementById('searchResults');
  const currentPeerEl = document.getElementById('currentPeer');
  const messagesEl = document.getElementById('messages');
  const msgInput = document.getElementById('msgInput');
  const oneTimeChk = document.getElementById('oneTimeChk');
  const ttlInput = document.getElementById('ttlInput');
  const sendBtn = document.getElementById('sendBtn');
  const regName = document.getElementById('regName');
  const regPass = document.getElementById('regPass');
  const regBtn = document.getElementById('regBtn');
  const loginBtn = document.getElementById('loginBtn');
  const connBtn = document.getElementById('connBtn');
  const logoutBtn = document.getElementById('logoutBtn');

  let ws = null;
  let myId = null;
  let friends = [];
  let currentPeer = null;
  const oneTimeMap = new Map();
  const chatPanels = new Map(); // peerId -> panel element
  const unreadCounts = new Map(); // peerId -> number

  function getPanel(peerId) {
    let panel = chatPanels.get(peerId);
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'panel';
      panel.dataset.peerId = peerId;
      messagesEl.appendChild(panel);
      chatPanels.set(peerId, panel);
    }
    return panel;
  }

  function showPanel(peerId) {
    for (const p of chatPanels.values()) p.classList.remove('active');
    const panel = getPanel(peerId);
    panel.classList.add('active');
    unreadCounts.set(peerId, 0);
    renderFriends();
  }

  function addMessageElTo(peerId, side, text, extraClass = '') {
    const panel = getPanel(peerId);
    const div = document.createElement('div');
    div.className = `msg ${side} ${extraClass}`;
    div.textContent = text;
    panel.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function renderFriends() {
    friendListEl.innerHTML = '';
    friends.forEach(f => {
      const li = document.createElement('li');
      const name = f.username ? `${f.username} (${f.userId})` : f.userId;
      const nameSpan = document.createElement('span');
      nameSpan.textContent = name;
      li.appendChild(nameSpan);
      const cnt = unreadCounts.get(f.userId) || 0;
      if (cnt > 0) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = String(cnt);
        li.appendChild(badge);
      }
      const btn = document.createElement('button');
      btn.textContent = '聊天';
      btn.onclick = () => { currentPeer = f.userId; currentPeerEl.textContent = f.username || f.userId; showPanel(currentPeer); };
      li.appendChild(btn);
      friendListEl.appendChild(li);
    });
  }

  function connect() {
    const savedId = localStorage.getItem('userId');
    if (!savedId) { alert('请先注册'); return; }
    const secure = (typeof window !== 'undefined' && window.isSecureContext) || location.protocol === 'https:';
    const wsProto = secure ? 'wss' : 'ws';
    const overrideFull = (window.WS_URL || localStorage.getItem('WS_URL') || '').trim();
    const overrideHost = (window.WS_BASE || localStorage.getItem('WS_BASE') || location.host);
    const url = overrideFull ? `${overrideFull}?userId=${encodeURIComponent(savedId)}` : `${wsProto}://${overrideHost}/?userId=${encodeURIComponent(savedId)}`;
    ws = new WebSocket(url);
    ws.addEventListener('open', () => {
      setInterval(() => ws && ws.readyState === 1 && ws.send(JSON.stringify({ type: 'ping', payload: {} })), 20000);
    });
    ws.addEventListener('message', onWsMessage);
  }

  function onWsMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    const { type, payload } = msg;
    if (type === 'user_info') {
      myId = payload.userId;
      myIdEl.textContent = myId;
      ws.send(JSON.stringify({ type: 'get_friends', payload: {} }));
      return;
    }
    if (type === 'friends_update') {
      friends = payload.friends || [];
      renderFriends();
      return;
    }
    if (type === 'message') {
      addMessageElTo(payload.from, 'peer', payload.content);
      if (currentPeer !== payload.from) {
        const c = unreadCounts.get(payload.from) || 0;
        unreadCounts.set(payload.from, c + 1);
        renderFriends();
      }
      return;
    }
    if (type === 'message_sent') {
      addMessageElTo(payload.to, 'me', payload.content);
      return;
    }
    if (type === 'one_time_stub') {
      const id = payload.messageId;
      const div = addMessageElTo(payload.from, 'peer', `一次性消息（点击查看）`, 'stub');
      div.style.cursor = 'pointer';
      div.onclick = () => {
        const ok = confirm('确认查看此一次性消息？查看后将开始倒计时销毁');
        if (!ok) return;
        ws.send(JSON.stringify({ type: 'request_reveal', payload: { messageId: id } }));
      };
      oneTimeMap.set(id, div);
      if (currentPeer !== payload.from) {
        const c = unreadCounts.get(payload.from) || 0;
        unreadCounts.set(payload.from, c + 1);
        renderFriends();
      }
      return;
    }
    if (type === 'one_time_reveal') {
      const id = payload.messageId;
      const div = oneTimeMap.get(id);
      if (div) {
        const ttlSec = payload.ttlSec ?? 30;
        div.textContent = `${payload.content}（将在${ttlSec}s后销毁）`;
      } else {
        const ttlSec = payload.ttlSec ?? 30;
        addMessageElTo(payload.from, 'peer', `${payload.content}（将在${ttlSec}s后销毁）`);
      }
      return;
    }
    if (type === 'one_time_sent') {
      const id = payload.messageId;
      const div = addMessageElTo(payload.to, 'me', `已发送一次性消息，占位，等待对方查看`, 'stub');
      oneTimeMap.set(id, div);
      return;
    }
    if (type === 'one_time_destroyed') {
      const id = payload.messageId;
      const div = oneTimeMap.get(id);
      if (div) {
        div.classList.add('destroy');
        div.textContent = `一次性消息已销毁（原因：${payload.reason}）`;
        oneTimeMap.delete(id);
      }
      return;
    }
    if (type === 'error') {
      alert(payload.message);
      return;
    }
  }

  regBtn.onclick = async () => {
    const name = regName.value.trim();
    const pass = regPass.value;
    if (!name) return;
    const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: pass }) });
    const data = await r.json();
    if (data.userId) {
      localStorage.setItem('userId', data.userId);
      myIdEl.textContent = data.userId;
      updateAuthUI();
      connect();
    } else {
      alert(data.error || '注册失败');
    }
  };

  loginBtn.onclick = async () => {
    const name = regName.value.trim();
    const pass = regPass.value;
    if (!name) { alert('请输入用户名'); return; }
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: pass }) });
    const data = await r.json();
    if (data.ok) {
      localStorage.setItem('userId', data.userId);
      myIdEl.textContent = data.userId;
      updateAuthUI();
      connect();
    } else {
      alert(data.error || '登录失败');
    }
  };

  connBtn.onclick = () => {
    const savedId = localStorage.getItem('userId');
    if (!savedId) { alert('请先注册或登录'); return; }
    updateAuthUI();
    connect();
  };

  logoutBtn.onclick = () => {
    if (ws && ws.readyState === 1) ws.close();
    ws = null;
    localStorage.removeItem('userId');
    myId = null;
    friends = [];
    currentPeer = null;
    friendListEl.innerHTML = '';
    messagesEl.innerHTML = '';
    currentPeerEl.textContent = '未选择';
    myIdEl.textContent = '未连接';
    updateAuthUI();
  };

  addFriendBtn.onclick = async () => {
    const fid = friendInput.value.trim();
    if (!fid) return;
    if (!ws) { alert('请先连接聊天'); return; }
    const looksLikeId = /^[A-Za-z0-9]{8,12}$/.test(fid);
    if (looksLikeId) {
      ws.send(JSON.stringify({ type: 'add_friend', payload: { friendId: fid } }));
    } else {
      // search by username
      const r = await fetch(`/api/search_users?query=${encodeURIComponent(fid)}`);
      const data = await r.json();
      const results = data.results || [];
      searchResultsEl.innerHTML = '';
      if (results.length === 0) { alert('未找到匹配用户名'); }
      results.forEach(user => {
        const li = document.createElement('li');
        li.textContent = `${user.username} (${user.userId})`;
        const btn = document.createElement('button');
        btn.textContent = '添加';
        btn.onclick = () => {
          ws.send(JSON.stringify({ type: 'add_friend', payload: { friendId: user.userId } }));
          searchResultsEl.innerHTML = '';
        };
        li.appendChild(btn);
        searchResultsEl.appendChild(li);
      });
    }
    friendInput.value = '';
  };

  sendBtn.onclick = () => {
    const text = msgInput.value.trim();
    if (!text) return;
    if (!currentPeer) { alert('请选择聊天对象'); return; }
    const oneTime = oneTimeChk.checked;
    const ttlSec = Number(ttlInput.value || 30);
    if (!ws) { alert('请先连接聊天'); return; }
    ws.send(JSON.stringify({ type: 'send_message', payload: { to: currentPeer, content: text, oneTime, ttlSec } }));
    msgInput.value = '';
  };

  if (localStorage.getItem('userId')) {
    myIdEl.textContent = localStorage.getItem('userId');
  }
  updateAuthUI();
})();
  function updateAuthUI() {
    const hasId = !!localStorage.getItem('userId');
    regName.style.display = hasId ? 'none' : '';
    regPass.style.display = hasId ? 'none' : '';
    regBtn.style.display = hasId ? 'none' : '';
    loginBtn.style.display = hasId ? 'none' : '';
    connBtn.style.display = hasId ? 'none' : '';
    logoutBtn.style.display = hasId ? '' : 'none';
  }
