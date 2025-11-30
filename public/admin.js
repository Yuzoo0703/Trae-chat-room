let adminToken = '';
const admUser = document.getElementById('admUser');
const admPass = document.getElementById('admPass');
const loginBtn = document.getElementById('loginBtn');
const loadBtn = document.getElementById('loadBtn');
const wipeBtn = document.getElementById('wipeBtn');
const userList = document.getElementById('userList');

async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {}, adminToken ? { 'Authorization': `Bearer ${adminToken}` } : {});
  const r = await fetch(path, Object.assign({}, opts, { headers }));
  return r.json();
}

loginBtn.onclick = async () => {
  const u = admUser.value.trim();
  const p = admPass.value;
  const r = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
  const data = await r.json();
  if (data.token) {
    adminToken = data.token;
    alert('后台登录成功');
  } else {
    alert(data.error || '后台登录失败');
  }
};

loadBtn.onclick = async () => {
  const data = await api('/api/admin/users');
  userList.innerHTML = '';
  if (data.users) {
    for (const u of data.users) {
      const li = document.createElement('li');
      li.textContent = `${u.username} (${u.userId})`;
      const btn = document.createElement('button');
      btn.textContent = '删除';
      btn.onclick = async () => {
        const ok = confirm(`确认删除用户 ${u.username}?`);
        if (!ok) return;
        const res = await api(`/api/admin/users/${u.userId}`, { method: 'DELETE' });
        if (res.ok) loadBtn.onclick(); else alert(res.error || '删除失败');
      };
      li.appendChild(btn);
      userList.appendChild(li);
    }
  } else {
    alert(data.error || '加载失败');
  }
};

wipeBtn.onclick = async () => {
  const ok = confirm('确认清空所有数据并断开所有连接？');
  if (!ok) return;
  const res = await api('/api/admin/wipe', { method: 'POST' });
  if (res.ok) { userList.innerHTML = ''; alert('已清空'); } else { alert(res.error || '操作失败'); }
};
