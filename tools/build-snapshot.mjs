/* ============================================================
 * 每日快照构建器（供本地定时任务调用）
 * ------------------------------------------------------------
 * 用法：
 *   node tools/build-snapshot.mjs --date 2026-11-17
 *   node tools/build-snapshot.mjs --config data/source-config.json
 *
 * 重要：本脚本不包含、也不会调用任何平台爬虫。
 * 它只从你在 source-config.json 中显式配置的合规数据源读取：
 *   kind=file  从本地已导出的 JSON 读取
 *   kind=api   从你已获授权的数据接口拉取（密钥走环境变量）
 *   kind=demo  生成明确标注的演示样例
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const E = require('../engine.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function bjToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function resolveInRoot(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

const FORBIDDEN = ['nickname', 'uid', 'user_id', 'openid', 'ip', 'ip_location', 'phone', 'mobile', 'avatar', 'avatar_url'];

function validateInput(input) {
  if (!input || typeof input !== 'object') throw new Error('输入不是对象');
  if (!Array.isArray(input.creators) || !input.creators.length) throw new Error('缺少 creators 数组');
  if (!input.sourceLabel) throw new Error('缺少 sourceLabel（金融信息服务要求来源可追溯）');
  if (input.isDemo !== true && !input.coverageNote) {
    throw new Error('真实数据必须填写 coverageNote，说明覆盖范围与缺口');
  }
  let comments = 0;
  input.creators.forEach((c, i) => {
    if (!c.text) throw new Error('第 ' + (i + 1) + ' 位创作者缺少 text');
    if (!E.PLATFORMS.some((p) => p.id === c.platform)) {
      throw new Error('第 ' + (i + 1) + ' 位创作者的 platform 不合法');
    }
    (c.comments || []).forEach((cm) => {
      const obj = typeof cm === 'string' ? null : cm;
      if (obj) {
        const bad = FORBIDDEN.filter((k) => Object.prototype.hasOwnProperty.call(obj, k));
        if (bad.length) throw new Error('评论含未脱敏字段：' + bad.join(', ') + '。请先完成字段最小化与匿名化');
      }
      comments += 1;
    });
  });
  return { creators: input.creators.length, comments: comments };
}

async function readSource(cfg, date) {
  switch (cfg.kind) {
    case 'demo':
      return E.generateDemo(date);
    case 'file': {
      if (!cfg.path) throw new Error('kind=file 时必须配置 path');
      const raw = fs.readFileSync(resolveInRoot(cfg.path), 'utf8');
      return JSON.parse(raw);
    }
    case 'api': {
      if (!cfg.apiUrl) throw new Error('kind=api 时必须配置 apiUrl');
      const headers = { Accept: 'application/json' };
      const keyName = cfg.apiKeyEnv || 'SENTIMENT_API_KEY';
      const key = process.env[keyName];
      if (key) headers.Authorization = 'Bearer ' + key;
      const res = await fetch(cfg.apiUrl, { headers });
      if (!res.ok) throw new Error('数据源返回 HTTP ' + res.status);
      const json = await res.json();
      return Array.isArray(json) ? json[json.length - 1] : (json.snapshot || json);
    }
    default:
      throw new Error('不支持的 kind：' + cfg.kind + '（仅支持 file / api / demo）');
  }
}

function sqlLiteral(v) { return String(v == null ? '' : v).replace(/'/g, "''"); }

function buildInsert(input, counts) {
  const payload = sqlLiteral(JSON.stringify(input));
  return "INSERT INTO sentiment_snapshots " +
    "(trade_date, source_label, is_demo, sample_count, payload) VALUES (" +
    "'" + sqlLiteral(input.date) + "', " +
    "'" + sqlLiteral(input.sourceLabel) + "', " +
    (input.isDemo === true ? 'true' : 'false') + ", " +
    (counts.creators + counts.comments) + ", " +
    "'" + payload + "'::jsonb) " +
    "ON CONFLICT (trade_date) DO UPDATE SET " +
    "source_label = EXCLUDED.source_label, is_demo = EXCLUDED.is_demo, " +
    "sample_count = EXCLUDED.sample_count, payload = EXCLUDED.payload, created_at = now();";
}

async function main() {
  const date = arg('date', bjToday());
  const configPath = resolveInRoot(arg('config', 'data/source-config.json'));
  const cfg = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
    : { kind: 'demo', sourceLabel: '内置演示样例（非真实采集数据）' };

  console.log('[build-snapshot] date=' + date + ' kind=' + cfg.kind + ' config=' + path.relative(ROOT, configPath));
  if (cfg.compliance && cfg.compliance.noScraping === false) {
    throw new Error('配置中 noScraping=false，拒绝执行：本工具不接入任何绕过平台访问控制的数据');
  }

  const input = await readSource(cfg, date);
  input.date = date;
  if (cfg.sourceLabel) input.sourceLabel = cfg.sourceLabel;
  if (cfg.coverageNote) input.coverageNote = cfg.coverageNote;
  if (cfg.kind !== 'demo') input.isDemo = false;
  if (!input.generatedAt) input.generatedAt = new Date().toISOString();

  const counts = validateInput(input);
  const snap = E.analyze(input);
  console.log('[build-snapshot] creators=' + counts.creators + ' comments=' + counts.comments +
    ' pessimistic=' + snap.overall.pessimistic + '% optimistic=' + snap.overall.optimistic + '%' +
    ' confidence=' + snap.overall.confidence + '% demo=' + !!input.isDemo);

  // 构建产物放到项目目录之外，避免随静态站点一起发布到公网
  const WORK = process.env.SNAPSHOT_WORK_DIR
    ? path.resolve(process.env.SNAPSHOT_WORK_DIR)
    : path.resolve(ROOT, '..', 'snapshot-work');
  const snapDir = path.join(WORK, 'snapshots');
  const outDir = path.join(WORK, 'out');
  fs.mkdirSync(snapDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(snapDir, date + '.json'), JSON.stringify(input, null, 2), 'utf8');

  const sql = buildInsert(input, counts);
  fs.writeFileSync(path.join(outDir, 'insert.sql'), sql, 'utf8');
  fs.writeFileSync(path.join(outDir, 'insert-sql.base64.txt'),
    Buffer.from(sql, 'utf8').toString('base64'), 'utf8');

  /* 直接产出可提交的分段参数化写库包，供每日自动化使用。
     这样自动化不必自行切字符串、拼占位符，也不会把「适配器产物」误当成
     「构建后真正入库的对象」（后者会被补齐 date / isDemo / generatedAt）。 */
  const compact = JSON.stringify(input);
  const CHUNK = 750;
  const chunks = [];
  for (let i = 0; i < compact.length; i += CHUNK) chunks.push(compact.slice(i, i + CHUNK));
  if (chunks.join('') !== compact) throw new Error('payload 分段拼接校验失败');
  const params = [input.sourceLabel, ...chunks];
  const placeholders = chunks.map((_, i) => '$' + (i + 2)).join('||');
  const paramSql = 'INSERT INTO sentiment_snapshots ' +
    '(trade_date, source_label, is_demo, sample_count, payload) VALUES (' +
    "'" + sqlLiteral(input.date) + "', $1, " +
    (input.isDemo === true ? 'true' : 'false') + ', ' +
    (counts.creators + counts.comments) + ', (' + placeholders + ')::jsonb) ' +
    'ON CONFLICT (trade_date) DO UPDATE SET ' +
    'source_label = EXCLUDED.source_label, is_demo = EXCLUDED.is_demo, ' +
    'sample_count = EXCLUDED.sample_count, payload = EXCLUDED.payload, created_at = now();';
  const pack = {
    date: input.date,
    sourceLabel: input.sourceLabel,
    isDemo: input.isDemo === true,
    sampleCount: counts.creators + counts.comments,
    creators: counts.creators,
    comments: counts.comments,
    payloadBytes: Buffer.byteLength(compact, 'utf8'),
    chunkCount: chunks.length,
    sql: paramSql,
    parameters: params
  };
  fs.writeFileSync(path.join(outDir, 'payload-chunks.json'), JSON.stringify(pack), 'utf8');
  fs.writeFileSync(path.join(outDir, 'payload.json'), compact, 'utf8');

  console.log('[build-snapshot] wrote ' + path.relative(ROOT, path.join(snapDir, date + '.json')));
  console.log('[build-snapshot] wrote ' + path.relative(ROOT, path.join(outDir, 'insert-sql.base64.txt')) +
    ' (pass its content as sqlBase64 to db_exec_sql, mode=write)');
  console.log('[build-snapshot] wrote ' + path.relative(ROOT, path.join(outDir, 'payload-chunks.json')) +
    ' (' + chunks.length + ' 段，' + pack.payloadBytes + ' 字节，可直接提交 sql + parameters)');
}

main().catch((err) => {
  console.error('[build-snapshot] FAILED:', err && err.message ? err.message : err);
  process.exitCode = 1;
});
