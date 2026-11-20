/* ============================================================
 * 抖音数据源适配器：第三方按量数据接口 -> 统一数据契约
 * ------------------------------------------------------------
 * 用法：
 *   node tools/douyin-adapter.mjs --dry-run                     # 结构自检，不联网
 *   node tools/douyin-adapter.mjs --discover --confirm-due-diligence
 *                                                             # 关键词发现候选，写白名单
 *   node tools/douyin-adapter.mjs --confirm-due-diligence       # 生成当日真实快照
 *
 * 常用参数（均有默认值，自动化可直接无参调用）：
 *   --max-age-days 7            内容时效窗口（天），0 表示不限制
 *   --refresh-followers-days 7  粉丝数缓存有效期（天），到期才调用 users.get
 *   --discover-stale-days 7     候选池滚动发现周期（天），到期才调用 videos.search
 *   --max-videos 10             每位候选最多检查几条近期内容（一次接口返回，不额外扣费）
 *   --max-comments 15           每人保留的评论条数上限
 *   --no-relevance-filter       关闭 A 股相关性过滤（默认开启）
 *   --no-discover-if-stale      关闭候选池自动滚动发现（默认开启）
 *
 * 省钱与贴近实际的关键顺序：
 *   缓存粉丝数 -> 遍历候选近期内容 -> 时效/相关性过滤 -> 复合分排序取前 N
 *   -> 只对入选者取评论。被过滤账号不产生任何评论调用。
 *
 * 密钥优先级：环境变量 DATAXAPI_API_KEY > 项目外
 *   ../snapshot-work/secrets/dataxapi.key（单行明文，不随静态站发布）
 *
 * 输出：../snapshot-work/input/douyin-latest.json（项目目录之外）
 * 随后：node tools/build-snapshot.mjs --config data/source-config.json
 *
 * 合规前提（务必先读）：
 *  1. 调用的是第三方公开数据接口（DataXAPI），不是抖音官方 API，
 *     也不代表获得抖音官方授权。正式启用前须完成数据来源尽调，
 *     因此正式调用必须显式带 --confirm-due-diligence。
 *  2. 只处理公开内容；不绕过登录、签名、验证码、频控等访问控制。
 *  3. 评论仅保留 text。评论者 id / 昵称 / 头像 / IP 属地等个人信息
 *     在进入本项目前即丢弃，不落盘、不入库、不上云。
 *  4. API Key 不写入项目内配置文件、日志、URL 或回复。
 *  5. 输出的 isDemo=false 只表示「非内置演示样例」，
 *     不代表数据已获平台授权，请以 coverageNote 中的披露为准。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const E = require('../engine.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 云端运行包：工作目录由 SNAPSHOT_WORK_DIR 注入；不设置时保持原有项目外路径。
// 密钥一律优先取环境变量 DATAXAPI_API_KEY（由云端 Secrets 注入），不落盘。
const WORK = process.env.SNAPSHOT_WORK_DIR
  ? path.resolve(process.env.SNAPSHOT_WORK_DIR)
  : path.resolve(ROOT, '..', 'snapshot-work');
const BASE = 'https://api.dataxapi.com';
const KEY_FILE = path.join(WORK, 'secrets', 'dataxapi.key');

/* 单价按接口文档登记值填写，用于调用前预算拦截；实际扣费以账户账单为准。
   users.get 在不同文档中标注为免费或低价，此处按 0.0020 上限估算，避免低估成本。 */
const PRICE = {
  'videos.search': 0.0200,
  'users.get': 0.0020,
  'users.videos.list': 0.0020,
  'videos.comments.list': 0.0020
};

/* 单次调用最多重试 2 次。Idempotency-Key 由「日期 + 完整 URL」固定生成，
   因此重试不会造成重复扣费；失败调用本身也不计费。 */
const MAX_RETRY = 2;
const RETRY_BASE_MS = 600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 候选池关键词缺省值。滚动发现时优先沿用白名单里上一轮的关键词，避免口径缩水。 */
const DEFAULT_KEYWORDS = [
  'A股复盘', '财经', '大盘分析', '股市复盘', '股票', '行情分析', '股评', 'A股'
];

/* 写入快照的创作者对象允许出现的字段。任何第三方账号编号、主页链接等一律不落盘。 */
const CREATOR_KEEP = [
  'id', 'name', 'platform', 'followers', 'rank', 'publishedAt',
  'text', 'comments', 'rankScore', 'engagement'
];

/* 内容相关性：只纳入与 A 股/市场直接相关的表述，避免把生活、公益、泛科普内容计入情绪。
   有意不收「财经」这类过宽的词（此前出现过带 #财经 标签的槟榔科普）。 */
const RELEVANCE = [
  'A股', 'a股', '大A', '股票', '股市', '股民', '大盘', '沪指', '创业板', '科创',
  '指数', '行情', '复盘', '盘面', '板块', '个股', '涨停', '跌停', '反弹', '回调',
  '牛市', '熊市', '证券', '券商', '基金', '筹码', '主力', '龙虎榜', '题材', '短线',
  '收盘', '开盘', '早盘', '尾盘', '涨幅', '跌幅', 'K线', '半导体', '算力', '科技股',
  '降息', '降准', '央行', '成交额', '两融', '北向', '套牢', '割肉', '销户', '回本'
];

/* 评论对象中允许出现的唯一字段。任何其余字段一律丢弃。 */
const COMMENT_KEEP = ['text'];
const FORBIDDEN = [
  'nickname', 'uid', 'user_id', 'openid', 'ip', 'ip_location',
  'phone', 'mobile', 'avatar', 'avatar_url', 'author', 'id',
  'post_id', 'parent_id', 'root_id', 'ext', 'metrics'
];

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function flag(name) { return process.argv.includes('--' + name); }
function bjDate() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); }
function bjNow() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' +08:00';
}
function resolveInRoot(p) { return path.isAbsolute(p) ? p : path.join(ROOT, p); }
function cleanText(s) {
  // 与 engine.js 的 clean() 保持一致：表情标记、链接、@ 本来就不参与情绪计算
  return String(s || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[\w\u4e00-\u9fa5-]{1,20}/g, ' ')
    .replace(/\[[^\]]{1,8}\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* 抖音正文常把标题原样带一遍。直接拼接会让同一句措辞出现两次，
   既虚增情绪词命中次数，也把云端 payload 撑大。这里做包含关系去重。 */
function composeText(video) {
  const title = cleanText(video && video.title);
  const body = cleanText(video && video.text);
  if (!title) return body;
  if (!body) return title;
  if (body.includes(title)) return body;
  if (title.includes(body)) return title;
  return title + ' ' + body;
}

/* 环境变量优先；自动化任务未必继承交互式 shell 的环境变量，
   因此允许从项目外的本地凭据文件读取，避免每天 18:30 拿不到 Key。 */
function readKey() {
  const env = (process.env.DATAXAPI_API_KEY || '').trim();
  if (env) return env;
  try {
    if (fs.existsSync(KEY_FILE)) {
      const v = fs.readFileSync(KEY_FILE, 'utf8').trim();
      if (v) return v;
    }
  } catch (_) { /* 凭据文件不可读时按无密钥处理 */ }
  return '';
}

/* ------------------------------------------------------------
 * 本地结构样例：仅用于 --dry-run 校验契约与字段脱敏，
 * 不含任何真实账号、真实内容或真实情绪，也不会发起网络请求。
 * ------------------------------------------------------------ */
function dryResponses() {
  // 时间动态生成，避免硬编码日期在几天后把样例全判为过期，导致自检失去意义
  const recent = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const stale = new Date(Date.now() - 40 * 86400000).toISOString();
  const freshVideo = (id, label) => ({
    id: id,
    title: '结构样例标题 ' + label,
    text: '【半导体】周三大盘行情复盘：仅供字段校验，不代表任何真实观点。',
    published_at: recent,
    metrics: { likes: 12000, comments: 800, shares: 300, favorites: 500 }
  });
  const staleVideo = (id) => ({
    id: id + '_old',
    title: '结构样例过期内容',
    text: '过期内容：生活科普，与本次统计无关。',
    published_at: stale,
    metrics: { likes: 10, comments: 1, shares: 0, favorites: 0 }
  });
  return {
    'videos.search': () => ({
      data: {
        items: [
          { id: 'sample_video_1', author: { id: 'sample_sec_uid_1', name: '结构样例甲', followers: 980000 } },
          { id: 'sample_video_2', author: { id: 'sample_sec_uid_22', name: '结构样例乙', followers: 500000 } }
        ],
        page: { has_more: false, next_cursor: '' }
      }
    }),
    // 与真实接口一致：users.get 返回 data.account.metrics.followers
    'users.get': (id) => ({
      data: { account: { id, metrics: { followers: 1000000 - String(id).length * 137 } } }
    }),
    'users.videos.list': (id) => {
      const uid = String(id || '');
      let items;
      if (uid === 'sample_sec_uid_1') {
        // 第一条过期且跑题、第二条合格：验证「遍历多条」而不是只取第一条
        items = [staleVideo(uid), freshVideo(uid + '_new', '甲')];
      } else if (uid === 'sample_sec_uid_333') {
        // 全部过期：验证时效过滤会把该账号整体剔除
        items = [staleVideo(uid)];
      } else {
        items = [freshVideo(uid, '乙')];
      }
      return { data: { items, page: { has_more: false, next_cursor: '' } } };
    },
    'videos.comments.list': () => ({
      data: {
        items: [
          { id: 'c1', text: '结构样例评论：银行板块相对稳。',
            author: { id: 'u1', name: '张三', avatar_url: 'https://example.com/a.png' },
            ext: { ip_location: '广东' } },
          { id: 'c2', text: '结构样例评论：大盘还是谨慎。',
            author: { id: 'u2', name: '李四', avatar_url: 'https://example.com/b.png' },
            ext: { ip_location: '北京' } }
        ],
        page: { has_more: false, next_cursor: '' }
      }
    })
  };
}

async function callApi(endpoint, params, ctx) {
  const unit = PRICE[endpoint];
  if (unit == null) throw new Error('未登记单价的端点：' + endpoint);
  if (ctx.calls + 1 > ctx.maxCalls) throw new Error('达到调用次数上限 ' + ctx.maxCalls + '，已停止');
  if (ctx.spend + unit > ctx.budgetUsd) {
    throw new Error('预计花费 ' + (ctx.spend + unit).toFixed(4) + ' 美元将超出预算 ' +
      ctx.budgetUsd.toFixed(4) + ' 美元，已停止');
  }
  ctx.calls += 1;
  ctx.spend += unit;

  if (ctx.dryRun) return ctx.dryResponses[endpoint](params.id);

  const url = new URL(BASE + '/v1/douyin/' + endpoint.replace(/\./g, '/'));
  Object.entries(params).forEach(([k, v]) => {
    if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, String(v));
  });
  const idem = crypto.createHash('sha256')
    .update(ctx.date + '|' + url.toString())
    .digest('hex').slice(0, 32);
  // 上限按该端点单价给 1.5 倍余量：不为低价端点预留过高额度，也不误杀正常调用
  const maxPrice = (unit * 1.5).toFixed(4);
  const headers = {
    Accept: 'application/json',
    Authorization: 'Bearer ' + ctx.key,
    'Idempotency-Key': idem,
    'X-Max-Price': maxPrice
  };
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(endpoint + ' 返回 HTTP ' + res.status);
      const json = await res.json();
      if (!json || typeof json !== 'object') throw new Error(endpoint + ' 返回体不是 JSON 对象');
      return json;
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_RETRY || ctx.dryRun) break;
      await sleep(RETRY_BASE_MS * (attempt + 1));
    }
  }
  // 失败调用不收费，回退本次预估，避免预算统计虚高
  ctx.spend -= unit;
  console.error('[douyin-adapter] ' + endpoint + ' 重试 ' + MAX_RETRY +
    ' 次后仍失败：' + (lastErr && lastErr.message ? lastErr.message : lastErr));
  throw lastErr;
}

/* 字段最小化的唯一入口：评论只保留 text，其余一律不读取、不留存。 */
function minimalComment(item, stats) {
  const t = cleanText(item && item.text);
  if (!t) return null;
  Object.keys(item || {}).forEach((k) => {
    if (!COMMENT_KEEP.includes(k)) stats.dropped += 1;
  });
  if (item && item.author && typeof item.author === 'object') {
    stats.dropped += Object.keys(item.author).length;
  }
  if (item && item.ext && typeof item.ext === 'object') {
    stats.dropped += Object.keys(item.ext).length;
  }
  return { text: t };
}

function itemsOf(json) {
  const d = (json && json.data) || {};
  if (Array.isArray(d.items)) return d.items;
  if (Array.isArray(d.item)) return d.item;
  if (d.item && typeof d.item === 'object') return [d.item];
  // users.get 返回单个 account 对象，粉丝数在 metrics.followers
  if (d.account && typeof d.account === 'object') return [d.account];
  return [];
}
function pageOf(json) { return ((json && json.data) || {}).page || {}; }

async function fetchComments(videoId, pages, ctx, stats) {
  const out = [];
  let cursor = '';
  for (let p = 0; p < pages; p++) {
    const json = await callApi('videos.comments.list',
      { id: videoId, cursor: cursor || undefined, view: 'compact' }, ctx);
    itemsOf(json).forEach((it) => {
      const m = minimalComment(it, stats);
      if (m) out.push(m);
    });
    const page = pageOf(json);
    if (!page.has_more || !page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return out;
}

/* 关键词发现候选账号，省去手工找 30 个 sec_uid。
   产出只是候选名单，必须人工复核后才能用于正式采集。 */
function priorKeywords(paths) {
  for (const p of paths) {
    try {
      const old = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (old && Array.isArray(old.keywords) && old.keywords.length) return old.keywords;
    } catch (_) { /* 首次发现或文件不可读时继续尝试下一个 */ }
  }
  return DEFAULT_KEYWORDS;
}

async function runDiscover(ctx, outPath) {
  // 滚动发现沿用上一轮关键词，保证候选口径一致、不会因为默认值改变而缩水。
  // 自检模式下产物是独立文件，因此再回退一次到生产白名单的关键词口径。
  const productionPool = path.join(WORK, 'input', 'douyin-creators.json');
  // 自检产物不参与口径继承，直接对齐生产白名单的关键词
  const keywordSources = ctx.dryRun ? [productionPool] : [outPath];
  const keywords = String(arg('keywords', priorKeywords(keywordSources).join(',')))
    .split(',').map((s) => s.trim()).filter(Boolean);
  const found = new Map();
  for (const kw of keywords) {
    const json = await callApi('videos.search', {
      query: kw, sort: 'relevance', published_within: 'week', view: 'standard'
    }, ctx);
    itemsOf(json).forEach((v) => {
      const a = (v && v.author) || {};
      if (!a.id || !a.name || found.has(String(a.id))) return;
      found.set(String(a.id), {
        id: String(a.id),
        name: String(a.name),
        followers_hint: Number(a.followers) || 0,
        tag: '财经候选',
        source: 'douyin.videos.search 关键词=' + kw,
        addedAt: ctx.date
      });
    });
  }
  // 合并已有白名单，避免新一轮关键词把此前发现的高粉账号覆盖掉
  let prior = [];
  if (!ctx.dryRun && fs.existsSync(outPath)) {
    try {
      const old = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      if (old && Array.isArray(old.candidates)) prior = old.candidates;
    } catch (_) { /* 旧名单不可读时忽略 */ }
  }
  const merged = new Map();
  prior.forEach((c) => { if (c && c.id) merged.set(String(c.id), c); });
  const fresh = [...found.values()].filter((c) => !merged.has(c.id));
  fresh.forEach((c) => merged.set(c.id, c));
  if (!merged.size) throw new Error('搜索未返回任何可用候选账号，未写白名单');

  // 候选池设上限，避免长期滚动发现后每天的内容接口调用量无限增长（省钱）
  const limit = Number(arg('max-candidates', '60'));
  let list = [...merged.values()];
  let trimmed = 0;
  if (limit > 0 && list.length > limit) {
    list.sort((a, b) => (Number(b.followers_hint) || 0) - (Number(a.followers_hint) || 0));
    trimmed = list.length - limit;
    list = list.slice(0, limit);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    lastDiscoverAt: new Date().toISOString(),
    source: ctx.dryRun
      ? '结构校验样例（本地构造）'
      : '第三方公开数据接口（DataXAPI）· 抖音视频搜索，取数时间 ' + bjNow(),
    note: '本名单由关键词搜索自动产出并跨轮合并，仅供候选，不代表粉丝量排名。必须人工复核：剔除带货/娱乐/非财经账号，确认内容确与 A 股相关，再投入使用。followers_hint 为搜索返回值，正式排序以 users.get 为准。' +
      (trimmed ? ' 本轮因候选池上限裁剪 ' + trimmed + ' 位（按搜索返回的粉丝参考值降序保留）。' : ''),
    keywords: keywords,
    candidateLimit: limit,
    candidates: list
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log('[douyin-adapter] discover 关键词=' + keywords.join('|') +
    ' 本轮新增=' + fresh.length + ' 合并后候选=' + merged.size +
    (trimmed ? ' 裁剪=' + trimmed : '') +
    ' calls=' + ctx.calls + ' estimated_usd=' + ctx.spend.toFixed(4));
  console.log('[douyin-adapter] wrote ' + outPath);
  console.log('[douyin-adapter] 请人工复核名单后再执行正式采集。');
}

function assertContract(snapshot, top) {
  if (!snapshot.date || !snapshot.sourceLabel || !snapshot.coverageNote) {
    throw new Error('契约自检失败：缺少 date / sourceLabel / coverageNote');
  }
  if (!Array.isArray(snapshot.creators) || !snapshot.creators.length) {
    throw new Error('契约自检失败：creators 为空');
  }
  if (snapshot.creators.length > top) throw new Error('契约自检失败：创作者数量超过 top');
  snapshot.creators.forEach((c, i) => {
    if (!c.text) throw new Error('契约自检失败：第 ' + (i + 1) + ' 位创作者缺少 text');
    if (c.platform !== 'douyin') throw new Error('契约自检失败：platform 必须为 douyin');
    const extra = Object.keys(c).filter((k) => !CREATOR_KEEP.includes(k));
    if (extra.length) throw new Error('契约自检失败：创作者对象含未登记字段 ' + extra.join(', '));
    // 只用序号占位符，杜绝把第三方账号编号、主页链接等带入云端快照
    if (!/^dy_\d+$/.test(String(c.id))) {
      throw new Error('契约自检失败：创作者 id 必须是 dy_序号 占位符');
    }
    if (typeof c.followers !== 'number' || !Number.isFinite(c.followers)) {
      throw new Error('契约自检失败：followers 必须为有限数值');
    }
    if (!Number.isFinite(Date.parse(c.publishedAt))) {
      throw new Error('契约自检失败：publishedAt 不是有效时间');
    }
    (c.comments || []).forEach((cm) => {
      const bad = FORBIDDEN.filter((k) => Object.prototype.hasOwnProperty.call(cm, k));
      if (bad.length) throw new Error('契约自检失败：评论残留未脱敏字段 ' + bad.join(', '));
      if (Object.keys(cm).length !== 1 || !('text' in cm)) {
        throw new Error('契约自检失败：评论对象只能包含 text');
      }
    });
  });
  // 直接跑一次情绪引擎，确认契约可被 analyze 消费
  const snap = E.analyze(snapshot);
  if (!snap || !snap.overall) throw new Error('契约自检失败：情绪引擎无法分析');
  return snap;
}

async function main() {
  const date = arg('date', bjDate());
  const top = Number(arg('top', '20'));
  const pages = Number(arg('comment-pages', '1'));
  // 单人评论上限：控制云端 payload 体积，保证每日自动写库稳定；口径在 coverageNote 中披露
  const maxComments = Number(arg('max-comments', '15'));
  const maxCalls = Number(arg('max-calls', '120'));
  const budgetUsd = Number(arg('budget-usd', '1.00'));
  const dryRun = flag('dry-run');
  const discover = flag('discover');
  // 云端包：候选池必须落在 WORK 内，才能随仓库回写实现跨天缓存；
  // 同时与 runDiscover 的写入路径、productionPool 保持一致，避免缓存失效导致每天全量发现。
  const creatorsPath = (() => {
    const v = arg('creators', '');
    return v
      ? (path.isAbsolute(v) ? v : path.resolve(ROOT, v))
      : path.join(WORK, 'input', 'douyin-creators.json');
  })();
  const outPath = discover
    ? (dryRun ? path.join(WORK, 'input', 'douyin-creators-dry-run.json') : creatorsPath)
    : (dryRun
      ? path.join(WORK, 'input', 'douyin-dry-run.json')
      : path.join(WORK, 'input', 'douyin-latest.json'));

  const key = readKey();
  if (!dryRun && !key) {
    throw new Error('未找到 API Key。请把 Key 存入 ' + KEY_FILE +
      '（单行明文，项目外不发布），或设置环境变量 DATAXAPI_API_KEY；只想校验结构请加 --dry-run');
  }
  if (!dryRun && !flag('confirm-due-diligence')) {
    throw new Error('拒绝正式调用：请先完成第三方数据源合规尽调，再显式加 --confirm-due-diligence');
  }

  const ctx = {
    date, dryRun, key, maxCalls, budgetUsd, calls: 0, spend: 0,
    dryResponses: dryRun ? dryResponses() : null
  };

  if (discover) {
    await runDiscover(ctx, outPath);
    return;
  }

  const maxAgeDays = Number(arg('max-age-days', '7'));
  const refreshFansDays = Number(arg('refresh-followers-days', '7'));
  const discoverStaleDays = Number(arg('discover-stale-days', '7'));
  const maxVideos = Math.max(1, Number(arg('max-videos', '10')));
  const requireRelevance = !flag('no-relevance-filter');
  const autoDiscover = !flag('no-discover-if-stale');
  const DAY_MS = 86400000;
  const nowMs = Date.now();

  let whitelist = null;
  let candidates;
  if (dryRun) {
    // 自检一律用本地构造样例，不读取真实账号名单，确保产物不对应任何真实账号
    candidates = [
      { id: 'sample_sec_uid_1', name: '结构样例甲', followers: 900000 },
      { id: 'sample_sec_uid_22', name: '结构样例乙', followers: 500000 },
      { id: 'sample_sec_uid_333', name: '结构样例丙', followers: 100000 }
    ];
  } else if (fs.existsSync(creatorsPath)) {
    whitelist = JSON.parse(fs.readFileSync(creatorsPath, 'utf8'));
    candidates = whitelist.candidates || [];
  } else {
    throw new Error('缺少创作者白名单：请先运行 --discover（默认写入项目外 snapshot-work/input/douyin-creators.json），或参考 data/douyin-creators.example.json 手工填写');
  }
  if (!candidates.length) throw new Error('创作者白名单为空');

  // 候选池滚动发现：只有超过 discoverStaleDays 天才调用 videos.search，
  // 避免每天全量关键词搜索；这样新账号能进池、高热度账号能上位，同时控制成本。
  let didDiscover = false;
  let poolUpdatedAt = (whitelist && whitelist.lastDiscoverAt) || '';
  if (autoDiscover && !ctx.dryRun) {
    const last = poolUpdatedAt ? Date.parse(poolUpdatedAt) : NaN;
    const poolAgeDays = Number.isFinite(last) ? (nowMs - last) / DAY_MS : Infinity;
    if (poolAgeDays >= discoverStaleDays) {
      console.log('[douyin-adapter] 候选池' +
        (Number.isFinite(poolAgeDays) ? '已 ' + poolAgeDays.toFixed(1) + ' 天' : '从未') +
        '刷新，执行滚动发现（周期 ' + discoverStaleDays + ' 天）');
      await runDiscover(ctx, creatorsPath);
      whitelist = JSON.parse(fs.readFileSync(creatorsPath, 'utf8'));
      candidates = whitelist.candidates || [];
      poolUpdatedAt = whitelist.lastDiscoverAt || '';
      didDiscover = true;
      if (!candidates.length) throw new Error('滚动发现后候选池为空，已停止');
    }
  }

  const stats = {
    dropped: 0, missingFollowers: 0, hintFollowers: 0, missingVideo: 0,
    missingText: 0, stale: 0, offTopic: 0, cachedFans: 0, refreshedFans: 0,
    videosChecked: 0, rejectedStale: 0, rejectedOffTopic: 0, rejectedNoText: 0,
    noEligibleVideo: 0
  };

  // 1) 粉丝数：白名单缓存优先，超过 refreshFansDays 天才调用 users.get（省钱）
  const profiled = [];
  for (const c of candidates) {
    const cachedAge = c.followers_at ? (nowMs - Date.parse(c.followers_at)) / DAY_MS : Infinity;
    let followers = Number(c.followers) || 0;
    if (!followers || cachedAge >= refreshFansDays) {
      const json = await callApi('users.get', { id: c.id, view: 'compact' }, ctx);
      const item = itemsOf(json)[0] || {};
      const live = item.metrics && item.metrics.followers != null
        ? item.metrics.followers
        : (item.followers != null ? item.followers : null);
      if (live != null) {
        followers = Number(live) || 0;
        c.followers = followers;
        c.followers_at = new Date(nowMs).toISOString();
        c.followers_source = 'users.get';
        stats.refreshedFans += 1;
      } else {
        followers = Number(c.followers_hint) || 0;
        stats.hintFollowers += 1;
      }
    } else {
      stats.cachedFans += 1;
    }
    if (!followers) stats.missingFollowers += 1;
    profiled.push({ id: c.id, name: c.name || '未命名账号', followers });
  }
  if (whitelist && stats.refreshedFans && !ctx.dryRun) {
    whitelist.candidates = candidates;
    fs.writeFileSync(creatorsPath, JSON.stringify(whitelist, null, 2), 'utf8');
  }

  // 2) 每位候选检查近期多条内容（一次接口返回，不额外扣费），挑第一条同时满足
  //    时效与相关性要求的；再按复合分排序。只有最终入选者才会产生评论调用。
  const eligible = [];
  for (const p of profiled) {
    const vjson = await callApi('users.videos.list', { id: p.id, view: 'standard' }, ctx);
    const videos = itemsOf(vjson).slice(0, maxVideos);
    if (!videos.length) { stats.missingVideo += 1; continue; }
    const rejected = { stale: 0, offTopic: 0, noText: 0 };
    let hit = null;
    for (const video of videos) {
      stats.videosChecked += 1;
      if (!video || !video.id) { rejected.noText += 1; continue; }
      const publishedAt = String(video.published_at || '');
      const ts = Date.parse(publishedAt);
      // 未来时间戳按 0 天处理，避免 freshScore 越过 1
      const ageDays = Number.isFinite(ts) ? Math.max(0, (nowMs - ts) / DAY_MS) : Infinity;
      if (maxAgeDays > 0 && ageDays > maxAgeDays) { rejected.stale += 1; continue; }
      const text = composeText(video);
      if (!text) { rejected.noText += 1; continue; }
      if (requireRelevance && !RELEVANCE.some((w) => text.includes(w))) {
        rejected.offTopic += 1; continue;
      }
      const m = video.metrics || {};
      const engagement = (Number(m.likes) || 0) + 3 * (Number(m.comments) || 0) +
        5 * (Number(m.shares) || 0) + 2 * (Number(m.favorites) || 0);
      // 复合分：粉丝量 50% + 近期互动热度 35% + 内容时效 15%
      // 粉丝量与互动量用 log10(1+x)/7 归一化到约 0~1，避免头部大号完全压过中小账号
      const fansScore = Math.log10(1 + Math.max(0, p.followers)) / 7;
      const heatScore = Math.log10(1 + Math.max(0, engagement)) / 7;
      const windowDays = maxAgeDays > 0 ? maxAgeDays : 7;
      const freshScore = Math.min(1, Math.max(0, 1 - ageDays / windowDays));
      const rankScore = 0.5 * fansScore + 0.35 * heatScore + 0.15 * freshScore;
      hit = { p, video, text, publishedAt, ageDays, engagement, rankScore };
      break;
    }
    stats.rejectedStale += rejected.stale;
    stats.rejectedOffTopic += rejected.offTopic;
    stats.rejectedNoText += rejected.noText;
    if (!hit) {
      stats.noEligibleVideo += 1;
      // 按账号计的主因，只记一个，避免重复计数
      if (rejected.stale) stats.stale += 1;
      else if (rejected.offTopic) stats.offTopic += 1;
      else stats.missingText += 1;
      continue;
    }
    eligible.push(hit);
  }
  eligible.sort((a, b) => b.rankScore - a.rankScore);
  const picked = eligible.slice(0, top);
  // 入榜过少时统计意义不足；如实失败，不静默放宽口径凑数。
  // 自检模式只有 3 个构造账号，下限相应放宽到 1。
  const minEligible = ctx.dryRun ? 1 : Math.min(5, top);
  if (picked.length < minEligible) {
    throw new Error('时效/相关性过滤后仅 ' + picked.length + ' 位候选可入榜（池内 ' +
      candidates.length + ' 位），样本不足，已停止。请扩候选池或调整 --max-age-days，' +
      '不要关闭过滤来凑数。');
  }

  // 3) 只对入选者取评论，被过滤掉的账号不产生评论调用（省钱）
  const rows = [];
  for (const e of picked) {
    const comments = (await fetchComments(e.video.id, pages, ctx, stats)).slice(0, maxComments);
    const rank = rows.length + 1;
    rows.push({
      // 用排序名次作为标识，不把第三方账号编号写入快照
      id: 'dy_' + rank,
      name: e.p.name,
      platform: 'douyin',
      followers: e.p.followers,
      rank: rank,
      publishedAt: e.publishedAt,
      text: e.text,
      comments: comments,
      rankScore: Math.round(e.rankScore * 1000) / 1000,
      engagement: e.engagement
    });
  }
  if (!rows.length) throw new Error('没有取到任何可用内容，已停止，不会写入空快照');

  const times = rows.map((r) => Date.parse(r.publishedAt)).filter(Number.isFinite);
  const timeRange = times.length
    ? '入榜内容发布时间 ' + new Date(Math.min(...times)).toISOString().slice(0, 10) +
      ' 至 ' + new Date(Math.max(...times)).toISOString().slice(0, 10) + '。'
    : '';
  const poolNote = '候选池由财经关键词搜索滚动发现，每 ' + discoverStaleDays +
    ' 天自动刷新一次（上次刷新 ' + (poolUpdatedAt ? poolUpdatedAt.slice(0, 10) : '未记录') +
    '，本次' + (didDiscover ? '已执行刷新' : '未触发刷新') + '），池内 ' + candidates.length +
    ' 位候选。';
  const rankNote = '入榜按复合分动态排序：粉丝量 50% + 近期互动热度 35% + 内容时效 15%；' +
    '粉丝量与互动量经 log10(1+x)/7 归一化，热度＝点赞＋3×评论＋5×分享＋2×收藏。' +
    '粉丝数每 ' + refreshFansDays + ' 天刷新一次（本次实时刷新 ' + stats.refreshedFans +
    ' 位、沿用缓存 ' + stats.cachedFans + ' 位，缺失 ' + stats.missingFollowers +
    ' 位、回退搜索参考值 ' + stats.hintFollowers + ' 位）。' +
    '名次随粉丝量与近期互动热度每日变化，不是固定名单，也不是平台官方榜单。';
  const timeFilterDesc = maxAgeDays > 0
    ? '仅纳入近 ' + maxAgeDays + ' 天内发布且含 A 股/市场相关表述的公开内容'
    : '不限发布时间，但须含 A 股/市场相关表述';
  const filterNote = '每位候选检查最多 ' + maxVideos + ' 条近期内容（本次共检查 ' +
    stats.videosChecked + ' 条），' + timeFilterDesc + '；按视频条数计，过期 ' +
    stats.rejectedStale + ' 条、跑题 ' + stats.rejectedOffTopic + ' 条、无文案或视频标识 ' +
    stats.rejectedNoText + ' 条；按账号计，无可入选内容 ' + stats.noEligibleVideo +
    ' 位（主因过期 ' + stats.stale + ' 位、跑题 ' + stats.offTopic + ' 位、无文案 ' +
    stats.missingText + ' 位）、接口未返回视频 ' + stats.missingVideo + ' 位；' +
    '最终入榜 ' + rows.length + ' 位。' + timeRange;
  const commentNote = '每位入榜者取 1 条入选内容及其前 ' + pages +
    ' 页公开评论，按接口返回顺序最多保留 ' + maxComments +
    ' 条（非全量、非随机抽样，可能偏向热评）；评论只保留文本，' +
    '评论者标识、昵称、头像、IP 属地等个人信息在进入本项目前即丢弃，' +
    '并已去除表情、链接等噪声文本。';

  const snapshot = {
    date: date,
    generatedAt: new Date().toISOString(),
    sourceLabel: dryRun
      ? '结构校验样例（本地构造，非真实采集数据）'
      : '第三方公开数据接口（DataXAPI）· 抖音，取数时间 ' + bjNow(),
    isDemo: dryRun,
    coverageNote: dryRun
      ? '本文件为字段契约与脱敏逻辑的本地校验样例，不对应任何真实账号、内容或市场情绪。'
      : poolNote + rankNote + filterNote + commentNote +
        '未覆盖公众号、视频号、小红书，未覆盖候选池外账号。' +
        '数据来自第三方公开数据接口，非抖音官方授权，仅用于公开内容措辞统计，' +
        '不构成任何投资建议或行情预测。',
    creators: rows
  };

  const snap = assertContract(snapshot, top);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2), 'utf8');

  console.log('[douyin-adapter] mode=' + (dryRun ? 'dry-run' : 'live') +
    ' date=' + date + ' creators=' + rows.length +
    ' comments=' + rows.reduce((n, r) => n + r.comments.length, 0));
  console.log('[douyin-adapter] pool=' + candidates.length +
    ' discover=' + (didDiscover ? 'yes' : 'no') +
    ' videos_checked=' + stats.videosChecked +
    ' stale=' + stats.rejectedStale + ' offTopic=' + stats.rejectedOffTopic +
    ' noText=' + stats.rejectedNoText + ' noEligible=' + stats.noEligibleVideo);
  console.log('[douyin-adapter] fans_cached=' + stats.cachedFans +
    ' fans_refreshed=' + stats.refreshedFans +
    ' comment_calls_skipped=' + (candidates.length - picked.length));
  console.log('[douyin-adapter] calls=' + ctx.calls +
    ' estimated_usd=' + ctx.spend.toFixed(4) +
    ' dropped_pii_fields=' + stats.dropped);
  console.log('[douyin-adapter] pessimistic=' + snap.overall.pessimistic +
    '% optimistic=' + snap.overall.optimistic +
    '% confidence=' + snap.overall.confidence + '%');
  console.log('[douyin-adapter] wrote ' + outPath);
  if (dryRun) {
    console.log('[douyin-adapter] 注意：dry-run 产物 isDemo=true，切勿用于每日快照入库。');
  }
}

main().catch((err) => {
  console.error('[douyin-adapter] FAILED:', err && err.message ? err.message : err);
  process.exitCode = 1;
});
