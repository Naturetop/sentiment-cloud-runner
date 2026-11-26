/* ============================================================
 * 云端每日任务入口（不依赖 WorkBuddy 客户端 / 本机文件 / 数据库 MCP）
 * ------------------------------------------------------------
 * 用法：DATAXAPI_API_KEY=xxx node collect.mjs
 *
 * 产出：
 *   public/snapshots/YYYY-MM-DD.json   当日统一数据契约
 *   public/latest.json                 最近 30 天契约数组（按日期升序）
 *
 * 前端「设置 → 数据源 → 自定义接口」填 latest.json 的公网 URL 即可，
 * loadApi() 会把数组最后一个作为当日快照、其余作为历史趋势。
 *
 * 说明：本运行包只生成静态快照，不写 WorkBuddy 云数据库——
 * 云数据库写入只能在 WorkBuddy 会话内通过 MCP 完成，那正是「必须开着
 * 客户端」的根因。绕开它，才能做到电脑关机也照跑。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const WORK = path.join(ROOT, 'state');
const PUB = path.join(ROOT, 'public');
const DAILY = path.join(ROOT, 'tools', 'daily-snapshot.mjs');

function bjToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function ensure(d) { fs.mkdirSync(d, { recursive: true }); }
function run(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], {
    stdio: 'inherit',
    env: Object.assign({}, process.env, { SNAPSHOT_WORK_DIR: WORK })
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(path.basename(script) + ' 退出码 ' + r.status);
}

function main() {
  const date = bjToday();
  if (!process.env.DATAXAPI_API_KEY) {
    throw new Error('缺少 DATAXAPI_API_KEY 环境变量（应由托管平台 Secrets 注入，不要写进仓库）');
  }
  ensure(path.join(PUB, 'snapshots'));
  ensure(path.join(WORK, 'input'));
  ensure(path.join(WORK, 'secrets'));

  // 采集 → 新鲜度校验 → 构建统一契约；任一环节失败即非零退出
  // 适配器调参由 SNAPSHOT_ADAPTER_ARGS 注入（默认空，行为与原来一致）。
  // 这些参数经 daily-snapshot.mjs 透传给适配器，构建器用按名查找解析参数，
  // 不认识的标志会被忽略，不影响快照产物。
  const extraArgs = (process.env.SNAPSHOT_ADAPTER_ARGS || '')
    .split(/\s+/).filter(Boolean);
  run(DAILY, ['--date', date, ...extraArgs]);

  const src = path.join(WORK, 'snapshots', date + '.json');
  if (!fs.existsSync(src)) throw new Error('未找到当日快照：' + src);
  const snap = JSON.parse(fs.readFileSync(src, 'utf8'));
  if (snap.isDemo === true) throw new Error('产物被标记为演示数据，拒绝发布');
  if (!Array.isArray(snap.creators) || !snap.creators.length) throw new Error('产物 creators 为空');
  if (snap.date !== date) {
    throw new Error('产物日期 ' + snap.date + ' 与今日 ' + date + ' 不一致，拒绝把旧数据冒充当日快照');
  }

  fs.writeFileSync(path.join(PUB, 'snapshots', date + '.json'), JSON.stringify(snap, null, 2), 'utf8');

  // 历史以已归档的按日契约为准，最多 30 天，避免依赖云端沙箱的可变文件系统
  const days = fs.readdirSync(path.join(PUB, 'snapshots'))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 10))
    .sort()
    .slice(-30);
  const all = days.map((d) =>
    JSON.parse(fs.readFileSync(path.join(PUB, 'snapshots', d + '.json'), 'utf8')));
  fs.writeFileSync(path.join(PUB, 'latest.json'), JSON.stringify(all), 'utf8');

  console.log('[collect] 完成：' + date + '，' + snap.creators.length + ' 位创作者，' +
    days.length + ' 天历史，latest.json ' +
    fs.statSync(path.join(PUB, 'latest.json')).size + ' 字节');
}

main();
