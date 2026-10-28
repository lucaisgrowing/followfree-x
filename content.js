(() => {
  if (globalThis.__followFreeLoaded) return;
  globalThis.__followFreeLoaded = true;

  // X 网页端公开 Bearer（所有网页访客共用，非任何人的私钥）
  const X_WEB_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  const RECENT_UNFOLLOW_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  const S = {
    running: false,
    stopRequested: false,
    stopSignalSeen: 0,
    notifWarned: false,
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cookie = (name) => (document.cookie.split(';').map((x) => x.trim()).find((x) => x.startsWith(name + '=')) || '').slice(name.length + 1);

  function myUserId() {
    try {
      const twid = decodeURIComponent(cookie('twid') || '');
      const m = twid.match(/u=(\d+)/);
      return m ? m[1] : '';
    } catch { return ''; }
  }
  function myUsername() {
    const link = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
    const href = link && link.getAttribute('href');
    if (href && /^\/[A-Za-z0-9_]+$/.test(href)) return href.slice(1);
    const m = location.pathname.match(/^\/([A-Za-z0-9_]+)\/(verified_followers|followers|following)/);
    return m ? m[1] : '';
  }

  async function storeGet(keys) { return chrome.storage.local.get(keys); }
  async function storeSet(obj) { return chrome.storage.local.set(obj); }

  let progress = null;
  async function setProgress(patch) {
    progress = { ...(progress || {}), ...patch, updatedAt: Date.now() };
    await storeSet({ followFreeProgress: progress });
  }
  async function logLine(text) {
    const log = [...((progress && progress.log) || []), `[${new Date().toLocaleTimeString()}] ${text}`].slice(-60);
    await setProgress({ log });
  }

  async function checkStop() {
    if (S.stopRequested) return true;
    const { followFreeStopSignal } = await storeGet('followFreeStopSignal');
    if (followFreeStopSignal && followFreeStopSignal !== S.stopSignalSeen) {
      S.stopSignalSeen = followFreeStopSignal;
      S.stopRequested = true;
      return true;
    }
    return false;
  }

  function xFetch(path, options = {}) {
    return fetch(`https://x.com/i/api/1.1/${path}`, {
      credentials: 'include',
      ...options,
      headers: {
        authorization: 'Bearer ' + X_WEB_BEARER,
        'x-csrf-token': cookie('ct0'),
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        'content-type': 'application/x-www-form-urlencoded',
        ...(options.headers || {}),
      },
    });
  }

  async function friendshipsCreate(userId) {
    const body = new URLSearchParams({ user_id: userId, follow: 'true' });
    const res = await xFetch('friendships/create.json', { method: 'POST', body });
    return parseXResponse(res);
  }
  async function friendshipsDestroy(userId) {
    const body = new URLSearchParams({ user_id: userId });
    const res = await xFetch('friendships/destroy.json', { method: 'POST', body });
    return parseXResponse(res);
  }
  async function friendshipsShow(sourceId, targetId) {
    const res = await xFetch(`friendships/show.json?source_id=${encodeURIComponent(sourceId)}&target_id=${encodeURIComponent(targetId)}`);
    if (!res.ok) return null;
    try { return await res.json(); } catch { return null; }
  }
  // 发帖作者没有数字 ID：关注与关系查询都直接用用户名（1.1 接口支持 screen_name），不再依赖 users/show.json 换 ID
  async function friendshipsCreateByName(username) {
    const body = new URLSearchParams({ screen_name: username, follow: 'true' });
    const res = await xFetch('friendships/create.json', { method: 'POST', body });
    return parseXResponse(res);
  }
  async function friendshipsShowByNames(sourceName, targetName) {
    const res = await xFetch(`friendships/show.json?source_screen_name=${encodeURIComponent(sourceName)}&target_screen_name=${encodeURIComponent(targetName)}`);
    if (!res.ok) return null;
    try { return await res.json(); } catch { return null; }
  }
  // 关注会顺带打开对方的发帖通知（device 通知开关）：关注成功后立刻关掉，只关通知、
  // 显式保留转帖可见（retweets=true），不改动时间线内容。失败不影响关注计数，每轮只提示一次。
  async function disablePostNotifications(target) {
    const body = new URLSearchParams({ device: 'false', retweets: 'true' });
    if (target.userId) body.set('user_id', target.userId);
    else body.set('screen_name', target.username);
    const res = await xFetch('friendships/update.json', { method: 'POST', body });
    const r = await parseXResponse(res);
    if (!r.ok && !S.notifWarned) {
      S.notifWarned = true;
      await logLine(`发帖通知关闭接口无返回（${r.message}），本轮已关注的账号请手动在对方主页点铃铛关闭`);
    }
    return r.ok;
  }
  async function parseXResponse(res) {
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (res.ok) return { ok: true, data };
    const errs = (data && data.errors) || [];
    const code = errs[0] && errs[0].code;
    const rateLimited = res.status === 429 || code === 88 || code === 185 || code === 344;
    return { ok: false, status: res.status, code, message: (errs[0] && errs[0].message) || `HTTP ${res.status}`, rateLimited };
  }

  function parseRow(row) {
    const links = row.querySelectorAll('a[href^="/"]');
    let username = '';
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/^\/([A-Za-z0-9_]{1,15})$/);
      if (m && !['home', 'explore', 'notifications', 'messages', 'search'].includes(m[1])) { username = m[1]; break; }
    }
    if (!username) return null;
    const btn = row.querySelector('[data-testid$="-follow"], [data-testid$="-following"], [data-testid$="-unfollow"]');
    const testid = btn ? btn.getAttribute('data-testid') : '';
    const userId = testid ? testid.split('-')[0] : '';
    const state = testid.endsWith('-following') ? 'following' : testid.endsWith('-unfollow') ? 'following' : testid.endsWith('-follow') ? 'not-following' : '';
    const verified = !!row.querySelector('[data-testid="icon-verified"]');
    // “回关”徽标是独立小标签：只认元素全文精确等于徽标文案，避免被简介里的字眼误伤
    const FOLLOW_YOU_LABELS = new Set(['Follows you', '关注你', '关注了你', '關注你', '關注了你', '跟隨你', 'Te sigue', 'Se abona a ti']);
    let followsYou = false;
    for (const el of row.querySelectorAll('span, div')) {
      if (FOLLOW_YOU_LABELS.has((el.textContent || '').trim())) { followsYou = true; break; }
    }
    return { username, userId, state, verified, followsYou };
  }

  async function scanList({ limit, onCandidate }) {
    const seen = new Map();
    let stall = 0;
    let lastCount = -1;
    while (seen.size < limit) {
      if (await checkStop()) break;
      const rows = document.querySelectorAll('[data-testid="UserCell"]');
      for (const row of rows) {
        const rec = parseRow(row);
        if (!rec || seen.has(rec.username.toLowerCase())) continue;
        seen.set(rec.username.toLowerCase(), rec);
        if (seen.size <= 3) {
          await logLine(`样本${seen.size}：@${rec.username} id=${rec.userId || '未读到'} 状态=${rec.state || '未知'} 蓝V=${rec.verified} 回关我=${rec.followsYou}`);
        }
        if (onCandidate) await onCandidate(rec, seen.size);
        if (seen.size >= limit) break;
      }
      if (seen.size === lastCount) stall += 1; else stall = 0;
      lastCount = seen.size;
      if (stall >= 8) break; // 连续 8 次滚动无新增 = 到底
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(1500);
    }
    return [...seen.values()];
  }

  async function waitForWindowSlot(kind, maxPerWindow) {
    while (true) {
      if (await checkStop()) return false;
      const key = kind === 'follow' ? 'followFreeFollowWindow' : 'followFreeUnfollowWindow';
      const data = await storeGet(key);
      const now = Date.now();
      const win = (data[key] || []).filter((t) => now - t < 15 * 60 * 1000);
      if (win.length < maxPerWindow) return true;
      const waitMs = Math.min(win[0] + 15 * 60 * 1000 - now + 1000, 60000);
      await logLine(`已达 ${maxPerWindow} 次/15分钟 上限，等 ${Math.ceil(waitMs / 1000)} 秒滑出窗口…`);
      await sleep(Math.max(waitMs, 5000));
    }
  }
  async function recordAction(kind) {
    const key = kind === 'follow' ? 'followFreeFollowWindow' : 'followFreeUnfollowWindow';
    const data = await storeGet(key);
    const win = [...(data[key] || []), Date.now()].filter((t) => Date.now() - t < 15 * 60 * 1000);
    await storeSet({ [key]: win });
  }
  function actionDelayMs(cfg) {
    if (cfg.intervalSec && cfg.intervalSec > 0) return cfg.intervalSec * 1000;
    return 5000 + Math.floor(Math.random() * 3000); // 随机 5–8 秒
  }

  async function runFollowBack(cfg) {
    const me = myUsername();
    if (!me) { await logLine('没识别到当前账号，请先在 X 页面停留几秒再试。'); return; }
    const targetPath = cfg.onlyVerified ? 'verified_followers' : 'followers';
    if (!location.pathname.includes(`/${targetPath}`)) {
      await storeSet({ followFreePendingTask: { mode: 'follow', cfg, ts: Date.now() } });
      await logLine(`正在跳转到你的 ${cfg.onlyVerified ? '已认证粉丝' : '粉丝'}列表…`);
      location.href = `https://x.com/${me}/${targetPath}`;
      return;
    }
    const { followFreeRecentUnfollows } = await storeGet('followFreeRecentUnfollows');
    const recentUnfollows = followFreeRecentUnfollows || {};
    const queue = [];
    await setProgress({ mode: 'follow', phase: 'scanning', checked: 0, acted: 0, failed: 0, skipped: 0, list: [] });
    await logLine(`开始扫描 ${cfg.onlyVerified ? '已认证粉丝' : '粉丝'}（上限 ${cfg.scanLimit} 人）…`);
    await scanList({
      limit: cfg.scanLimit,
      onCandidate: async (rec, count) => {
        await setProgress({ checked: count });
        if (rec.state !== 'not-following') { await setProgress({ skipped: (progress.skipped || 0) + 1 }); return; }
        if (!rec.userId) { await setProgress({ skipped: (progress.skipped || 0) + 1 }); return; }
        const unfTs = recentUnfollows[rec.username.toLowerCase()];
        if (unfTs && Date.now() - unfTs < RECENT_UNFOLLOW_TTL_MS) {
          await setProgress({ skipped: (progress.skipped || 0) + 1 });
          await logLine(`跳过 @${rec.username}（30 天内取关过，防反复横跳）`);
          return;
        }
        queue.push(rec);
      },
    });
    await logLine(`扫描完成：检查 ${progress.checked} 人，待回关 ${queue.length} 人。开始回关…`);
    await setProgress({ phase: 'acting' });
    const myId = myUserId();
    let acted = 0;
    for (const rec of queue) {
      if (acted >= cfg.maxActions) { await logLine(`已达本轮上限 ${cfg.maxActions} 人，停止。`); break; }
      if (await checkStop()) { await logLine('已手动停止。'); break; }
      if (!(await waitForWindowSlot('follow', cfg.maxPerWindow))) break;
      const r = await friendshipsCreate(rec.userId);
      if (!r.ok) {
        await setProgress({ failed: (progress.failed || 0) + 1 });
        await logLine(`回关 @${rec.username} 失败：${r.message}`);
        if (r.rateLimited) { await logLine('X 返回限流，本轮结束。等 15 分钟后再跑。'); break; }
        continue;
      }
      // 只读复核一次，确认关系真的建立
      await sleep(1500);
      let confirmed = true;
      if (myId) {
        const rel = await friendshipsShow(myId, rec.userId);
        if (rel && rel.relationship && rel.relationship.source) confirmed = Boolean(rel.relationship.source.following);
      }
      acted += 1;
      await recordAction('follow');
      await disablePostNotifications({ userId: rec.userId });
      await setProgress({ acted, list: [...(progress.list || []), rec.username] });
      await logLine(confirmed ? `✅ 已回关 @${rec.username}（${acted}/${cfg.maxActions}）` : `⚠️ @${rec.username} 已发送但复核未确认，计入本轮防重复`);
      if (acted < cfg.maxActions) await sleep(actionDelayMs(cfg));
    }
    await setProgress({ phase: 'done', running: false });
    await logLine(`回关任务结束：成功 ${acted}，失败 ${progress.failed || 0}，跳过 ${progress.skipped || 0}。`);
  }

  async function runUnfollow(cfg) {
    const me = myUsername();
    if (!me) { await logLine('没识别到当前账号，请先在 X 页面停留几秒再试。'); return; }
    if (!location.pathname.endsWith('/following')) {
      await storeSet({ followFreePendingTask: { mode: 'unfollow', cfg, ts: Date.now() } });
      await logLine('正在跳转到你的正在关注列表…');
      location.href = `https://x.com/${me}/following`;
      return;
    }
    const whitelist = new Set((cfg.whitelist || []).map((x) => x.replace(/^@/, '').toLowerCase()));
    const queue = [];
    const skipReasons = { noHit: 0, whitelist: 0, noId: 0, topSkip: 0 };
    await setProgress({ mode: 'unfollow', phase: 'scanning', checked: 0, acted: 0, failed: 0, skipped: 0, list: [] });
    await logLine(`开始扫描正在关注（上限 ${cfg.scanLimit} 人${cfg.skipTop ? `，跳过列表前 ${cfg.skipTop} 位` : ''}）…`);
    await scanList({
      limit: cfg.scanLimit,
      onCandidate: async (rec, count) => {
        await setProgress({ checked: count });
        if (cfg.skipTop && count <= cfg.skipTop) {
          skipReasons.topSkip += 1;
          await setProgress({ skipped: (progress.skipped || 0) + 1 });
          return;
        }
        const hitNonFollower = cfg.includeNonFollowers && !rec.followsYou;
        const hitUnverified = cfg.includeUnverified && !rec.verified;
        if (!hitNonFollower && !hitUnverified) { skipReasons.noHit += 1; await setProgress({ skipped: (progress.skipped || 0) + 1 }); return; }
        if (whitelist.has(rec.username.toLowerCase())) {
          skipReasons.whitelist += 1;
          await setProgress({ skipped: (progress.skipped || 0) + 1 });
          await logLine(`白名单跳过 @${rec.username}`);
          return;
        }
        if (!rec.userId) { skipReasons.noId += 1; await setProgress({ skipped: (progress.skipped || 0) + 1 }); return; }
        queue.push({ ...rec, reason: [hitNonFollower ? '未回关' : '', hitUnverified ? '无蓝V' : ''].filter(Boolean).join('+') });
      },
    });
    await logLine(`跳过明细：未命中条件 ${skipReasons.noHit}，白名单 ${skipReasons.whitelist}，没读到用户ID ${skipReasons.noId}${skipReasons.topSkip ? `，列表前 ${cfg.skipTop} 位保护 ${skipReasons.topSkip}` : ''}`);
    await logLine(`扫描完成：检查 ${progress.checked} 人，命中 ${queue.length} 人${cfg.scanOnly ? '（只扫不取关）' : ''}。`);
    await setProgress({ list: queue.map((q) => q.username), candidates: queue.map((q) => ({ u: q.username, r: q.reason })) });
    if (cfg.scanOnly) { await setProgress({ phase: 'done', running: false }); await logLine('名单已保存，在插件面板可导出 CSV。'); return; }
    await setProgress({ phase: 'acting', list: [] });
    let acted = 0;
    const { followFreeRecentUnfollows } = await storeGet('followFreeRecentUnfollows');
    const recentUnfollows = followFreeRecentUnfollows || {};
    for (const rec of queue) {
      if (acted >= cfg.maxActions) { await logLine(`已达本轮上限 ${cfg.maxActions} 人，停止。`); break; }
      if (await checkStop()) { await logLine('已手动停止。'); break; }
      if (!(await waitForWindowSlot('unfollow', cfg.maxPerWindow))) break;
      const r = await friendshipsDestroy(rec.userId);
      if (!r.ok) {
        await setProgress({ failed: (progress.failed || 0) + 1 });
        await logLine(`取关 @${rec.username} 失败：${r.message}`);
        if (r.rateLimited) { await logLine('X 返回限流，本轮结束。等 15 分钟后再跑。'); break; }
        continue;
      }
      acted += 1;
      recentUnfollows[rec.username.toLowerCase()] = Date.now();
      await recordAction('unfollow');
      await setProgress({ acted, list: [...(progress.list || []), rec.username] });
      await logLine(`✅ 已取关 @${rec.username}（${rec.reason}，${acted}/${cfg.maxActions}）`);
      if (acted < cfg.maxActions) await sleep(actionDelayMs(cfg));
    }
    await storeSet({ followFreeRecentUnfollows: recentUnfollows });
    await setProgress({ phase: 'done', running: false });
    await logLine(`取关任务结束：成功 ${acted}，失败 ${progress.failed || 0}，跳过 ${progress.skipped || 0}。`);
  }

  // 帖子里的作者：只取主帖的 User-Name 区（引用帖排在后面，不会误取）
  function parseTweetAuthor(article) {
    const nameBox = article.querySelector('[data-testid="User-Name"]');
    if (!nameBox) return null;
    let username = '';
    for (const a of nameBox.querySelectorAll('a[href^="/"]')) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/^\/([A-Za-z0-9_]{1,15})$/);
      if (m && !['home', 'explore', 'notifications', 'messages', 'search', 'settings', 'i'].includes(m[1])) { username = m[1]; break; }
    }
    if (!username) return null;
    const verified = !!nameBox.querySelector('[data-testid="icon-verified"]');
    return { username, verified };
  }

  // 关键词搜索条件：关键词 + 可选 since: / until: / min_faves: 运算符，𝕏 服务端直接筛
  function buildKeywordQuery(cfg) {
    const parts = [cfg.keyword];
    if (cfg.timeRange === 'custom') {
      if (cfg.customSince) parts.push('since:' + cfg.customSince);
      if (cfg.customUntil) parts.push('until:' + cfg.customUntil);
    } else if (cfg.timeRange && cfg.timeRange !== 'any') {
      const days = parseInt(cfg.timeRange, 10);
      if (Number.isFinite(days) && days > 0) {
        const d = new Date(Date.now() - days * 86400000);
        parts.push('since:' + d.toISOString().slice(0, 10));
      }
    }
    if (cfg.minFaves && cfg.minFaves > 0) parts.push('min_faves:' + cfg.minFaves);
    return parts.join(' ');
  }

  async function runKeywordPostFollow(cfg) {
    const me = myUsername();
    if (!me) { await logLine('没识别到当前账号，请先在 𝕏 页面停留几秒再试。'); return; }
    const query = buildKeywordQuery(cfg);
    const expectedF = cfg.sort === 'top' ? 'top' : 'live';
    const params = new URLSearchParams(location.search);
    const onSearchPage = location.hostname === 'x.com' && location.pathname === '/search' && params.get('f') === expectedF && params.get('q') === query;
    if (!onSearchPage) {
      await storeSet({ followFreePendingTask: { mode: 'keyword', cfg, ts: Date.now() } });
      await logLine(`正在跳转到关键词「${cfg.keyword}」的${expectedF === 'top' ? '热门' : '最新'}帖子搜索页…`);
      location.href = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=${expectedF}`;
      return;
    }
    const authors = new Map();
    const seenTweets = new Set();
    let scanned = 0;
    let stall = 0;
    let lastCount = -1;
    await setProgress({ mode: 'keyword', phase: 'scanning', checked: 0, acted: 0, failed: 0, skipped: 0, list: [] });
    const filterDesc = [
      cfg.timeRange === 'custom' ? `自定义时间 ${cfg.customSince || '不限'}~${cfg.customUntil || '不限'}` : (cfg.timeRange && cfg.timeRange !== 'any' ? `${cfg.timeRange}天内` : ''),
      cfg.minFaves && cfg.minFaves > 0 ? `点赞≥${cfg.minFaves}` : '',
    ].filter(Boolean).join('，');
    await logLine(`开始按发帖关键词「${cfg.keyword}」扫描${expectedF === 'top' ? '热门' : '最新'}帖子（上限 ${cfg.scanLimit} 条${filterDesc ? `，筛选：${filterDesc}` : ''}）…`);
    while (scanned < cfg.scanLimit) {
      if (await checkStop()) break;
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      for (const article of articles) {
        if (scanned >= cfg.scanLimit) break;
        const statusLink = article.querySelector('a[href*="/status/"]');
        const tweetKey = statusLink ? statusLink.getAttribute('href') : '';
        if (tweetKey) {
          if (seenTweets.has(tweetKey)) continue;
          seenTweets.add(tweetKey);
        }
        scanned += 1;
        const rec = parseTweetAuthor(article);
        if (!rec || authors.has(rec.username.toLowerCase())) continue;
        authors.set(rec.username.toLowerCase(), rec);
        if (authors.size <= 3) {
          await logLine(`样本${authors.size}：@${rec.username} 蓝V=${rec.verified}`);
        }
      }
      await setProgress({ checked: scanned });
      if (scanned === lastCount) stall += 1; else stall = 0;
      lastCount = scanned;
      if (stall >= 8) break; // 连续 8 次滚动无新增 = 到底
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(1500);
    }
    const { followFreeRecentUnfollows } = await storeGet('followFreeRecentUnfollows');
    const recentUnfollows = followFreeRecentUnfollows || {};
    const queue = [];
    let skipped = 0;
    let showNulls = 0;
    for (const rec of authors.values()) {
      if (queue.length >= cfg.maxActions) break;
      if (rec.username.toLowerCase() === me.toLowerCase()) { skipped += 1; continue; }
      if (cfg.onlyVerified && !rec.verified) { skipped += 1; continue; }
      const unfTs = recentUnfollows[rec.username.toLowerCase()];
      if (unfTs && Date.now() - unfTs < RECENT_UNFOLLOW_TTL_MS) {
        skipped += 1;
        await logLine(`跳过 @${rec.username}（30 天内取关过，防反复横跳）`);
        continue;
      }
      // 关系查不到（接口无返回）不跳过，默认按未关注处理——避免一次接口问题导致全军覆没
      const rel = await friendshipsShowByNames(me, rec.username);
      if (!rel) { showNulls += 1; }
      else if (rel.relationship && rel.relationship.source && rel.relationship.source.following) {
        skipped += 1;
        continue;
      }
      queue.push(rec);
    }
    if (showNulls > 0) await logLine(`关系查询 ${showNulls} 次无返回，已按未关注处理`);
    await setProgress({ skipped: (progress.skipped || 0) + skipped });
    await logLine(`扫描完成：检查 ${scanned} 条帖子，去重作者 ${authors.size} 人，待关注 ${queue.length} 人。开始关注…`);
    await setProgress({ phase: 'acting' });
    let acted = 0;
    for (const rec of queue) {
      if (acted >= cfg.maxActions) { await logLine(`已达本轮上限 ${cfg.maxActions} 人，停止。`); break; }
      if (await checkStop()) { await logLine('已手动停止。'); break; }
      if (!(await waitForWindowSlot('follow', cfg.maxPerWindow))) break;
      const r = await friendshipsCreateByName(rec.username);
      if (!r.ok) {
        await setProgress({ failed: (progress.failed || 0) + 1 });
        await logLine(`关注 @${rec.username} 失败：${r.message}`);
        if (r.rateLimited) { await logLine('𝕏 返回限流，本轮结束。等 15 分钟后再跑。'); break; }
        continue;
      }
      await sleep(1500);
      let confirmed = true;
      const rel = await friendshipsShowByNames(me, rec.username);
      if (rel && rel.relationship && rel.relationship.source) confirmed = Boolean(rel.relationship.source.following);
      acted += 1;
      await recordAction('follow');
      await disablePostNotifications({ username: rec.username });
      await setProgress({ acted, list: [...(progress.list || []), rec.username] });
      await logLine(confirmed ? `✅ 已关注 @${rec.username}（${acted}/${cfg.maxActions}）` : `⚠️ @${rec.username} 已发送但复核未确认，计入本轮防重复`);
      if (acted < cfg.maxActions) await sleep(actionDelayMs(cfg));
    }
    await setProgress({ phase: 'done', running: false });
    await logLine(`关键词关注结束：成功 ${acted}，失败 ${progress.failed || 0}，跳过 ${progress.skipped || 0}。`);
  }

  async function runKeywordFollow(cfg) {
    if (cfg.source === 'posts') { await runKeywordPostFollow(cfg); return; }
    const me = myUsername();
    if (!me) { await logLine('没识别到当前账号，请先在 𝕏 页面停留几秒再试。'); return; }
    const searchUrl = `https://x.com/search?q=${encodeURIComponent(cfg.keyword)}&src=typed_query&f=user`;
    if (!(location.hostname === 'x.com' && location.pathname === '/search' && new URLSearchParams(location.search).get('f') === 'user' && new URLSearchParams(location.search).get('q') === cfg.keyword)) {
      await storeSet({ followFreePendingTask: { mode: 'keyword', cfg, ts: Date.now() } });
      await logLine(`正在跳转到关键词「${cfg.keyword}」的用户搜索页…`);
      location.href = searchUrl;
      return;
    }
    const { followFreeRecentUnfollows } = await storeGet('followFreeRecentUnfollows');
    const recentUnfollows = followFreeRecentUnfollows || {};
    const queue = [];
    await setProgress({ mode: 'keyword', phase: 'scanning', checked: 0, acted: 0, failed: 0, skipped: 0, list: [] });
    await logLine(`开始按关键词「${cfg.keyword}」扫描用户搜索页（上限 ${cfg.scanLimit} 人）…`);
    await scanList({
      limit: cfg.scanLimit,
      onCandidate: async (rec, count) => {
        await setProgress({ checked: count });
        if (rec.username.toLowerCase() === me.toLowerCase()) { await setProgress({ skipped: (progress.skipped || 0) + 1 }); return; }
        if (rec.state !== 'not-following') { await setProgress({ skipped: (progress.skipped || 0) + 1 }); return; }
        if (!rec.userId) { await setProgress({ skipped: (progress.skipped || 0) + 1 }); return; }
        if (cfg.onlyVerified && !rec.verified) { await setProgress({ skipped: (progress.skipped || 0) + 1 }); return; }
        const unfTs = recentUnfollows[rec.username.toLowerCase()];
        if (unfTs && Date.now() - unfTs < RECENT_UNFOLLOW_TTL_MS) {
          await setProgress({ skipped: (progress.skipped || 0) + 1 });
          await logLine(`跳过 @${rec.username}（30 天内取关过，防反复横跳）`);
          return;
        }
        queue.push(rec);
      },
    });
    await logLine(`扫描完成：检查 ${progress.checked} 人，待关注 ${queue.length} 人。开始关注…`);
    await setProgress({ phase: 'acting' });
    const myId = myUserId();
    let acted = 0;
    for (const rec of queue) {
      if (acted >= cfg.maxActions) { await logLine(`已达本轮上限 ${cfg.maxActions} 人，停止。`); break; }
      if (await checkStop()) { await logLine('已手动停止。'); break; }
      if (!(await waitForWindowSlot('follow', cfg.maxPerWindow))) break;
      const r = await friendshipsCreate(rec.userId);
      if (!r.ok) {
        await setProgress({ failed: (progress.failed || 0) + 1 });
        await logLine(`关注 @${rec.username} 失败：${r.message}`);
        if (r.rateLimited) { await logLine('𝕏 返回限流，本轮结束。等 15 分钟后再跑。'); break; }
        continue;
      }
      await sleep(1500);
      let confirmed = true;
      if (myId) {
        const rel = await friendshipsShow(myId, rec.userId);
        if (rel && rel.relationship && rel.relationship.source) confirmed = Boolean(rel.relationship.source.following);
      }
      acted += 1;
      await recordAction('follow');
      await disablePostNotifications({ userId: rec.userId });
      await setProgress({ acted, list: [...(progress.list || []), rec.username] });
      await logLine(confirmed ? `✅ 已关注 @${rec.username}（${acted}/${cfg.maxActions}）` : `⚠️ @${rec.username} 已发送但复核未确认，计入本轮防重复`);
      if (acted < cfg.maxActions) await sleep(actionDelayMs(cfg));
    }
    await setProgress({ phase: 'done', running: false });
    await logLine(`关键词关注结束：成功 ${acted}，失败 ${progress.failed || 0}，跳过 ${progress.skipped || 0}。`);
  }

  async function startTask(mode, cfg) {
    if (S.running) return;
    S.running = true;
    S.stopRequested = false;
    S.notifWarned = false;
    const { followFreeStopSignal } = await storeGet('followFreeStopSignal');
    S.stopSignalSeen = followFreeStopSignal || 0;
    progress = { running: true, mode, phase: 'starting', checked: 0, acted: 0, failed: 0, skipped: 0, list: [], log: [] };
    await storeSet({ followFreeProgress: progress, followFreePendingTask: null });
    try {
      if (mode === 'follow') await runFollowBack(cfg);
      else if (mode === 'keyword') await runKeywordFollow(cfg);
      else await runUnfollow(cfg);
    } catch (e) {
      await logLine('任务异常停止：' + (e && e.message ? e.message : String(e)));
      await setProgress({ phase: 'error', running: false });
    } finally {
      S.running = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'FOLLOW_FREE_START') {
      startTask(msg.mode, msg.cfg);
      sendResponse({ ok: true });
    } else if (msg && msg.type === 'FOLLOW_FREE_WHO_AM_I') {
      sendResponse({ username: myUsername(), userId: myUserId() });
    }
    return true;
  });

  // 页面跳转后自动续跑
  (async () => {
    const { followFreePendingTask } = await storeGet('followFreePendingTask');
    if (followFreePendingTask && Date.now() - followFreePendingTask.ts < 5 * 60 * 1000) {
      await sleep(1500);
      startTask(followFreePendingTask.mode, followFreePendingTask.cfg);
    }
  })();
})();
