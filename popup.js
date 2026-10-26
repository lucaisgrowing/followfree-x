const $ = (id) => document.getElementById(id);

function showTab(which) {
  $('tab-follow').classList.toggle('active', which === 'follow');
  $('tab-unfollow').classList.toggle('active', which === 'unfollow');
  $('tab-keyword').classList.toggle('active', which === 'keyword');
  $('panel-follow').classList.toggle('hidden', which !== 'follow');
  $('panel-unfollow').classList.toggle('hidden', which !== 'unfollow');
  $('panel-keyword').classList.toggle('hidden', which !== 'keyword');
}
$('tab-follow').onclick = () => showTab('follow');
$('tab-unfollow').onclick = () => showTab('unfollow');
$('tab-keyword').onclick = () => showTab('keyword');

async function activeXTab() {
  let tabs = await chrome.tabs.query({ active: true, currentWindow: true, url: ['https://x.com/*', 'https://twitter.com/*'] });
  if (!tabs.length) tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  if (tabs.length) return tabs[0];
  return chrome.tabs.create({ url: 'https://x.com/home' });
}

// 等标签页加载完成（新开的页、刚跳转的页都需要）
async function waitForTabReady(tabId) {
  for (let i = 0; i < 20; i++) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === 'complete') return;
    } catch { return; }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// 发消息失败 = 页面里还没有插件脚本（刚更新/重装扩展后，已打开的标签页就是这样）：
// 先自动注入一次再重发；注入也失败才让用户刷新页面
async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (firstErr) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await new Promise((r) => setTimeout(r, 400));
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

async function refreshAccount() {
  try {
    const tab = await activeXTab();
    await waitForTabReady(tab.id);
    const res = await sendToTab(tab.id, { type: 'FOLLOW_FREE_WHO_AM_I' });
    $('account').textContent = res && res.username ? `当前账号：@${res.username}` : '已打开 X，但还没识别到账号（页面加载完再试）';
  } catch {
    $('account').textContent = '正在打开 X…稍等页面加载后重开面板';
  }
}

function num(id, fallback) { const v = parseInt($(id).value, 10); return Number.isFinite(v) && v > 0 ? v : fallback; }

async function start(mode) {
  const cfg = mode === 'follow'
    ? {
        scanLimit: Math.min(num('f-scanLimit', 200), 500),
        maxActions: num('f-maxActions', 15),
        maxPerWindow: 15,
        intervalSec: parseInt($('f-interval').value, 10) || 0,
        onlyVerified: $('f-scope-verified').checked,
        scope: $('f-scope-verified').checked ? 'verified' : 'all',
      }
    : mode === 'keyword'
    ? {
        keyword: $('k-keyword').value.trim(),
        source: $('k-source-posts').checked ? 'posts' : 'users',
        sort: $('k-sort-top').checked ? 'top' : 'live',
        timeRange: $('k-timeRange').value,
        minFaves: Math.max(0, parseInt($('k-minFaves').value, 10) || 0),
        scanLimit: 200,
        maxActions: num('k-maxActions', 15),
        maxPerWindow: 15,
        intervalSec: parseInt($('k-interval').value, 10) || 0,
        onlyVerified: $('k-onlyVerified').checked,
      }
    : {
        scanLimit: num('u-scanLimit', 200),
        maxActions: num('u-maxActions', 15),
        maxPerWindow: 15,
        intervalSec: parseInt($('u-interval').value, 10) || 0,
        skipTop: Math.max(0, Math.min(500, parseInt($('u-skipTop').value, 10) || 0)),
        includeNonFollowers: $('u-nonfollowers').checked,
        includeUnverified: $('u-unverified').checked,
        scanOnly: $('u-scanOnly').checked,
        whitelist: $('u-whitelist').value.split('\n').map((s) => s.trim()).filter(Boolean),
      };
  if (mode === 'keyword' && !cfg.keyword) {
    alert('先填一个关键词');
    return;
  }
  if (mode === 'unfollow' && !cfg.includeNonFollowers && !cfg.includeUnverified && !cfg.scanOnly) {
    alert('未回关、无蓝V至少勾一个（或勾只生成名单）');
    return;
  }
  const prev = (await chrome.storage.local.get('followFreeUiCfg')).followFreeUiCfg || {};
  await chrome.storage.local.set({ followFreeUiCfg: { ...prev, ...cfg, mode }, followFreeStopSignal: 0 });
  const tab = await activeXTab();
  await waitForTabReady(tab.id);
  try {
    await sendToTab(tab.id, { type: 'FOLLOW_FREE_START', mode, cfg });
  } catch {
    alert('插件脚本还没进 X 页面：请按 F5 刷新一次 X 页面，等页面完全加载后再点开始（刚更新/重装扩展后，已打开的标签页需要刷新一次）');
  }
}

$('f-start').onclick = () => start('follow');
$('u-start').onclick = () => start('unfollow');
$('k-start').onclick = () => start('keyword');
$('stop').onclick = async () => {
  await chrome.storage.local.set({ followFreeStopSignal: Date.now() });
};

$('u-export').onclick = async () => {
  const { followFreeProgress } = await chrome.storage.local.get('followFreeProgress');
  const rows = (followFreeProgress && followFreeProgress.candidates) || [];
  const list = (followFreeProgress && followFreeProgress.list) || [];
  const body = rows.length
    ? 'username,reason\n' + rows.map((r) => `${r.u},${r.r}`).join('\n')
    : 'username\n' + list.join('\n');
  const url = URL.createObjectURL(new Blob([body], { type: 'text/csv' }));
  await chrome.downloads?.download?.({ url, filename: 'followfree-x-list.csv' }).catch(() => {});
  const a = document.createElement('a');
  a.href = url; a.download = 'followfree-x-list.csv'; a.click();
};

const REPO = 'lucaisgrowing/followfree-x';

function cmpVer(a, b) {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

// 手动加载的本地扩展无法走商店静默升级：只联网查最新 Release，有新版就给下载页入口
async function checkUpdate() {
  const cur = chrome.runtime.getManifest().version;
  $('cur-version').textContent = 'v' + cur;
  $('upd-download').classList.add('hidden');
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const rel = await res.json();
    const latest = (rel.tag_name || '').replace(/^v/, '');
    if (!latest) throw new Error('no tag');
    if (cmpVer(latest, cur) > 0) {
      $('upd-status').textContent = `发现新版本 v${latest}`;
      const btn = $('upd-download');
      btn.textContent = `下载最新版 v${latest}`;
      btn.classList.remove('hidden');
      btn.onclick = () => chrome.tabs.create({ url: rel.html_url });
    } else {
      $('upd-status').textContent = '当前已是最新版本';
    }
  } catch {
    $('upd-status').textContent = '检查失败，稍后再试';
  }
}

$('upd-check').onclick = () => { $('upd-status').textContent = '正在检查更新…'; checkUpdate(); };
$('star-btn').onclick = () => chrome.tabs.create({ url: `https://github.com/${REPO}` });

async function renderProgress() {  const { followFreeProgress: p } = await chrome.storage.local.get('followFreeProgress');
  if (!p) return;
  $('st-checked').textContent = p.checked || 0;
  $('st-acted').textContent = p.acted || 0;
  $('st-skipped').textContent = p.skipped || 0;
  $('st-failed').textContent = p.failed || 0;
  $('st-phase').textContent = p.running ? `运行中·${p.phase || ''}` : (p.phase === 'done' ? '已完成' : '空闲');
  const logEl = $('log');
  logEl.textContent = (p.log || []).join('\n');
  logEl.scrollTop = logEl.scrollHeight;
}

(async () => {
  const ver = chrome.runtime.getManifest().version;
  $('hero-version').textContent = 'v' + ver;
  $('footer-version').textContent = 'v' + ver;
  const { followFreeUiCfg: c } = await chrome.storage.local.get('followFreeUiCfg');
  if (c) {
    if (c.whitelist) $('u-whitelist').value = c.whitelist.join('\n');
    if (typeof c.skipTop === 'number') $('u-skipTop').value = c.skipTop;
    if (c.scope) {
      $('f-scope-verified').checked = c.scope === 'verified';
      $('f-scope-all').checked = c.scope !== 'verified';
    }
    if (c.keyword) $('k-keyword').value = c.keyword;
    if (c.source) {
      $('k-source-posts').checked = c.source === 'posts';
      $('k-source-users').checked = c.source !== 'posts';
    }
    if (c.sort) {
      $('k-sort-top').checked = c.sort === 'top';
      $('k-sort-live').checked = c.sort !== 'top';
    }
    if (c.timeRange) $('k-timeRange').value = c.timeRange;
    if (typeof c.minFaves === 'number') $('k-minFaves').value = c.minFaves;
    if (c.mode === 'keyword' && typeof c.onlyVerified === 'boolean') $('k-onlyVerified').checked = c.onlyVerified;
  }
  refreshAccount();
  renderProgress();
  checkUpdate();
  setInterval(renderProgress, 700);
})();
