/* ============================================================
 * 云端快照上线核验（只读、零接口费用、不写任何文件）
 * ------------------------------------------------------------
 *   node verify.mjs https://<user>.github.io/<repo>/latest.json
 *   node verify.mjs ./public/latest.json          # 本地自测
 *
 * 校验：可读取 / 日期升序 / 非演示 / 来源与覆盖说明齐全 /
 *       评论字段最小化 / 首日日期新鲜度 / 引擎可重算三分占比。
 * ============================================================ */
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const E = require('./engine.js');

const FORBIDDEN = [
  'nickname', 'uid', 'user_id', 'openid', 'ip', 'ip_location',
  'phone', 'mobile', 'avatar', 'avatar_url'
];
const target = process.argv[2] || process.env.SNAPSHOT_URL || '';

function bjToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
async function load(t) {
  if (/^https?:\/\//i.test(t)) {
    const res = await fetch(t, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  }
  return JSON.parse(fs.readFileSync(t, 'utf8'));
}
function fail(msg) { throw new Error(msg); }

async function main() {
  if (!target) fail('用法：node verify.mjs <latest.json 的 URL 或本地路径>');
  const json = await load(target);
  const arr = Array.isArray(json) ? json
    : (Array.isArray(json.snapshots) ? json.snapshots : [json]);
  if (!arr.length) fail('快照数组为空');

  let comments = 0;
  arr.forEach((it, i) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(it.date || '')) fail('第 ' + (i + 1) + ' 项日期不合法');
    if (i && arr[i - 1].date > it.date) fail('数组未按日期升序排列');
    if (it.isDemo !== false) fail(it.date + ' 被标记为演示数据或缺少 isDemo=false');
    if (!it.sourceLabel) fail(it.date + ' 缺少 sourceLabel');
    if (!it.coverageNote) fail(it.date + ' 缺少 coverageNote');
    if (!Array.isArray(it.creators) || !it.creators.length) fail(it.date + ' creators 为空');
    it.creators.forEach((c, j) => {
      if (!c.text) fail(it.date + ' 第 ' + (j + 1) + ' 位创作者缺少 text');
      (c.comments || []).forEach((cm) => {
        comments += 1;
        if (!cm || typeof cm.text !== 'string' || !cm.text) fail(it.date + ' 存在空评论');
        Object.keys(cm).forEach((k) => {
          if (k !== 'text') fail(it.date + ' 评论含非文本字段 ' + k);
          if (FORBIDDEN.includes(k)) fail(it.date + ' 评论含未脱敏字段 ' + k);
        });
      });
    });
  });

  const latest = arr[arr.length - 1];
  const today = bjToday();
  const ageDays = Math.round((Date.parse(today + 'T00:00:00Z') -
    Date.parse(latest.date + 'T00:00:00Z')) / 86400000);
  if (ageDays < 0) fail('最新快照日期晚于今天：' + latest.date);
  if (ageDays > 2) fail('最新快照已过期 ' + ageDays + ' 天（' + latest.date + '），云端任务可能没跑');

  const s = E.analyze(latest);
  const a = s.overall.allSampleShares;
  console.log('来源            :', target.slice(0, 90));
  console.log('快照天数        :', arr.length, '（' + arr[0].date + ' → ' + latest.date + '）');
  console.log('最新日期/距今   :', latest.date, '/', ageDays, '天');
  console.log('最新创作者      :', s.creators.length);
  console.log('评论样本(累计)  :', comments);
  console.log('三分主指标      : 悲观 ' + a.pessimistic + '% / 乐观 ' + a.optimistic +
    '% / 中性 ' + a.neutral + '% = ' +
    (Math.round((a.pessimistic + a.optimistic + a.neutral) * 10) / 10) + '%');
  console.log('辅助二分        : 悲观 ' + s.overall.pessimistic + '% / 乐观 ' +
    s.overall.optimistic + '%');
  console.log('有效/全部样本   :', s.overall.effectiveSamples, '/', s.overall.totalSamples,
    '| 统计稳定性', s.overall.confidence + '%');
  console.log('数据源标签      :', latest.sourceLabel);
  console.log('VERIFY PASSED');
}

main().catch((e) => {
  console.error('VERIFY FAILED:', e && e.message ? e.message : e);
  process.exitCode = 1;
});
