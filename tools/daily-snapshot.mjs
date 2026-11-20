/* ============================================================
 * 每日快照编排器（供 18:30 自动化调用）
 * ------------------------------------------------------------
 * 用法：
 *   node tools/daily-snapshot.mjs
 *   node tools/daily-snapshot.mjs --date 2026-11-18
 *
 * 按 data/source-config.json 决定流程：
 *   kind=demo                    -> 直接构建明确标注的演示样例
 *   kind=file + douyinAdapter    -> 先刷新当日抖音适配器产物，再构建快照
 *   kind=file / kind=api（其他） -> 按配置直接构建
 *
 * 关键：真实数据模式下，若适配器失败则立即非零退出，
 * 绝不复用前一天的旧数据文件冒充当日真实数据，也不回退成演示数据。
 * 适配器成功后还会校验产物 generatedAt 是否为本次运行（30 分钟内），
 * 防止「脚本成功退出但文件没刷新」这种更隐蔽的旧数据冒充。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = path.join(ROOT, 'data', 'source-config.json');
const ADAPTER = path.join(ROOT, 'tools', 'douyin-adapter.mjs');
const BUILDER = path.join(ROOT, 'tools', 'build-snapshot.mjs');

function run(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(path.basename(script) + ' 退出码 ' + r.status);
}

/* 适配器成功退出不等于产物是本次生成的。若适配器因配置、缓存或异常
   没有刷新文件，build-snapshot 会把昨天的 JSON 强制改成今天日期写库，
   形成「旧数据冒充当日真实数据」。这里做一道硬性新鲜度校验。 */
function assertFreshAdapterOutput(cfg) {
  if (cfg.kind === 'demo' || cfg.douyinAdapter !== true) return;
  if (!cfg.path) throw new Error('douyinAdapter=true 但缺少 path');
  const p = path.isAbsolute(cfg.path) ? cfg.path : path.resolve(ROOT, cfg.path);
  if (!fs.existsSync(p)) throw new Error('适配器产物不存在：' + p);
  let json;
  try {
    json = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    throw new Error('适配器产物不是合法 JSON：' + p + '（' + err.message + '）');
  }
  const gen = Date.parse(json.generatedAt || '');
  if (!Number.isFinite(gen)) {
    throw new Error('适配器产物缺少有效 generatedAt，拒绝复用旧文件');
  }
  const ageMin = (Date.now() - gen) / 60000;
  if (ageMin > 30 || ageMin < -5) {
    throw new Error('适配器产物不是本次运行生成的（生成于 ' +
      new Date(gen).toISOString() + '，距今 ' + ageMin.toFixed(1) +
      ' 分钟），拒绝把旧数据冒充当日真实数据');
  }
  if (json.isDemo === true) {
    throw new Error('适配器产物被标记为演示数据，拒绝写入真实快照');
  }
  if (!Array.isArray(json.creators) || !json.creators.length) {
    throw new Error('适配器产物 creators 为空，拒绝写入空快照');
  }
  console.log('[daily-snapshot] 产物新鲜度校验通过：' + json.creators.length +
    ' 位创作者，生成于 ' + ageMin.toFixed(1) + ' 分钟前，isDemo=false');
}

function main() {
  const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  const args = process.argv.slice(2);

  if (cfg.kind === 'demo') {
    console.log('[daily-snapshot] 数据源=demo，跳过适配器，生成明确标注的演示样例');
  } else if (cfg.douyinAdapter === true) {
    console.log('[daily-snapshot] 数据源=真实，先刷新当日抖音适配器产物');
    run(ADAPTER, ['--confirm-due-diligence', ...args]);
  } else {
    console.log('[daily-snapshot] 数据源=' + cfg.kind + '，按配置直接构建');
  }

  assertFreshAdapterOutput(cfg);
  run(BUILDER, args);
}

try {
  main();
} catch (err) {
  console.error('[daily-snapshot] FAILED:', err && err.message ? err.message : err);
  process.exitCode = 1;
}
