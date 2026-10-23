const $ = (id) => document.getElementById(id);

function showTab(which) {
  $('tab-follow').classList.toggle('active', which === 'follow');
  $('tab-unfollow').classList.toggle('active', which === 'unfollow');
  $('panel-follow').classList.toggle('hidden', which !== 'follow');
  $('panel-unfollow').classList.toggle('hidden', which !== 'unfollow');
}
$('tab-follow').onclick = () => showTab('follow');
$('tab-unfollow').onclick = () => showTab('unfollow');

async function activeXTab() {
  let tabs = await chrome.tabs.query({ active: true, currentWindow: true, url: ['https://x.com/*', 'https://twitter.com/*'] });
  if (!tabs.length) tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  if (tabs.length) return tabs[0];
  return chrome.tabs.create({ url: 'https://x.com/home' });
}

async function refreshAccount() {
  try {
    const tab = await activeXTab();
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'FREE_WALL_WHO_AM_I' });
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
        onlyVerified: $('f-onlyVerified').checked,
      }
    : {
        scanLimit: num('u-scanLimit', 200),
        maxActions: num('u-maxActions', 15),
        maxPerWindow: 15,
        intervalSec: parseInt($('u-interval').value, 10) || 0,
        includeNonFollowers: $('u-nonfollowers').checked,
        includeUnverified: $('u-unverified').checked,
        scanOnly: $('u-scanOnly').checked,
        whitelist: $('u-whitelist').value.split('\n').map((s) => s.trim()).filter(Boolean),
      };
  if (mode === 'unfollow' && !cfg.includeNonFollowers && !cfg.includeUnverified && !cfg.scanOnly) {
    alert('未回关、无蓝V至少勾一个（或勾只生成名单）');
    return;
  }
  await chrome.storage.local.set({ freeWallUiCfg: cfg, freeWallStopSignal: 0 });
  const tab = await activeXTab();
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'FREE_WALL_START', mode, cfg });
  } catch {
    alert('X 页面还没加载好，等页面出来后再点一次开始');
  }
}

$('f-start').onclick = () => start('follow');
$('u-start').onclick = () => start('unfollow');
$('stop').onclick = async () => {
  await chrome.storage.local.set({ freeWallStopSignal: Date.now() });
};

$('u-export').onclick = async () => {
  const { freeWallProgress } = await chrome.storage.local.get('freeWallProgress');
  const rows = (freeWallProgress && freeWallProgress.candidates) || [];
  const list = (freeWallProgress && freeWallProgress.list) || [];
  const body = rows.length
    ? 'username,reason\n' + rows.map((r) => `${r.u},${r.r}`).join('\n')
    : 'username\n' + list.join('\n');
  const url = URL.createObjectURL(new Blob([body], { type: 'text/csv' }));
  await chrome.downloads?.download?.({ url, filename: 'free-wall-list.csv' }).catch(() => {});
  const a = document.createElement('a');
  a.href = url; a.download = 'free-wall-list.csv'; a.click();
};

async function renderProgress() {
  const { freeWallProgress: p } = await chrome.storage.local.get('freeWallProgress');
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
  const { freeWallUiCfg } = await chrome.storage.local.get('freeWallUiCfg');
  if (freeWallUiCfg && freeWallUiCfg.whitelist) $('u-whitelist').value = freeWallUiCfg.whitelist.join('\n');
  refreshAccount();
  renderProgress();
  setInterval(renderProgress, 700);
})();
