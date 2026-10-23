# Free Wall — X 回关/取关助手（自用免费版）

按 Wall Tools 两个收费插件（Follow Wall / Unfollow Wall）的逆向结论从零复刻的免费版：**没有授权校验、没有配对绑定、没有后端服务器、不上传任何数据**，两个功能合在一个插件里。

## 安装

1. 解压 zip（或直接用 free-wall 文件夹）
2. Chrome 打开 `chrome://extensions`，开启右上角「开发者模式」
3. 「加载已解压的扩展程序」→ 选择 `free-wall` 文件夹
4. 登录 x.com，点工具栏的 Free Wall 图标开面板

## 功能与原版对照

| | 原版 | 本免费版 |
|---|---|---|
| 扫描方式 | 打开自己的 verified_followers / following 页，DOM 滚动逐行读蓝V与关注状态 | 同 |
| 回关/取关执行 | 页面上下文调 `/i/api/1.1/friendships/create.json` / `destroy.json`，ct0 作 CSRF | 同（内容脚本同源 fetch） |
| 限流保护 | 15 次确认成功 / 15 分钟窗，随机 5–8 秒间隔，撞限流停轮 | 同（15/15min 硬顶 + 等窗滑出；间隔可自定义） |
| 防重复 | 结果不确定先隔离、30 天内取关过的不回关 | 同（取关记录本地保存 30 天，回关自动跳过） |
| 取关筛选 | 未回关 / 无蓝V 任选，白名单，只扫名单模式，CSV 导出 | 同 |
| 授权/付费 | OAuth 绑号 + license/check 逐动作校验，3 天试用后付费 | **无，打开就用** |
| 数据外发 | installationId 等发往 walltools.top | **零外发**，只有对 x.com 的 API 请求 |
| 权限 | storage + alarms + scripting，host 含 walltools.top | 只要 storage，host 只有 x.com/twitter.com |

## 使用

- **回关粉丝**：设扫描上限（最大 500）、本轮最多回关数、间隔 → 开始。插件自动跳到你的已认证粉丝页（或粉丝页）扫描并逐个回关，进度和日志在面板里实时刷
- **取关清理**：勾未回关/无蓝V（可双勾取并集），白名单每行一个用户名永不动；先勾「只生成名单」跑一遍、导出 CSV 看名单，确认后再正式取关
- 随时点「停止任务」；关掉面板不影响任务（任务跑在 X 页面的内容脚本里），重开面板能接着看进度

## 已知边界（跟原版一样的坑）

- X 改版 UserCell 的 DOM 结构或按钮 testid 后扫描会失效，需要跟着改选择器
- 私有 API 自动化本身违反 X 自动化规则的风险自担；15/15min 只是降概率，不保证不封
- 回关复核走 friendships/show.json，只读确认一次；未确认的计入本轮且不重发
- 任务跑在列表页标签里，**别关那个标签页**，关了就停了（进度已存的计数不丢）

## 文件

- `manifest.json` — MV3，只要 storage 权限
- `content.js` — 全部引擎（扫描/执行/限流/防重复），约 15KB
- `popup.html/css/js` — 双标签面板
