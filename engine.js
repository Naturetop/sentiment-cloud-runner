/* ============================================================
 * 情绪观察台 · 分析引擎
 * ------------------------------------------------------------
 * 输入：统一数据契约（创作者内容 + 评论文本）
 * 输出：每日情绪快照（占比 / 板块 / 平台 / 明细 / 口径）
 *
 * 设计原则：
 *  1. 只做「公开内容措辞」的统计，不预测涨跌、不给操作建议。
 *  2. 所有口径显式可查，样本量、置信度、中性样本一并给出。
 *  3. 纯函数、零依赖，浏览器与 Node 共用。
 * ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SentimentEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------------- 词典 ---------------- */
  // 权重为正 = 偏乐观表述；为负 = 偏悲观表述
  const LEXICON = {
    '看多': 1.2, '做多': 1.2, '看涨': 1.2, '上涨': 1, '反弹': 1, '反转': 1.1,
    '企稳': 1, '走强': 1, '走高': 1, '突破': 1, '拉升': 1, '修复': 0.9,
    '回暖': 1, '回升': 1, '复苏': 1.1, '见底': 1.2, '底部': 0.9, '低估': 1,
    '性价比': 0.9, '配置价值': 1.1, '布局机会': 1.2, '机会': 0.7, '利好': 1.2,
    '超预期': 1.3, '景气': 1, '增量资金': 1.2, '资金流入': 1.1, '净流入': 1,
    '政策支持': 1.1, '宽松': 0.9, '降准': 1, '降息': 1, '业绩改善': 1.2,
    '盈利修复': 1.1, '订单饱满': 1.1, '供不应求': 1, '涨价': 0.8, '确定性': 0.9,
    '赚钱效应': 1.2, '情绪回暖': 1.2, '超跌反弹': 1.1, '加仓': 1.1, '逢低': 1,
    '看好': 1.2, '乐观': 1.3, '积极': 1, '韧性': 0.9, '站稳': 1, '新高': 1.1,
    '量价齐升': 1.2, '放量上攻': 1.3, '主线': 0.6, '慢牛': 1.3, '牛市': 1.4,
    '高股息': 0.8, '红利': 0.7, '低估值': 1, '估值合理': 1, '修复空间': 1,
    '看空': -1.2, '做空': -1.2, '看跌': -1.2, '下跌': -1, '回调': -0.8,
    '调整': -0.6, '破位': -1.3, '杀跌': -1.3, '跳水': -1.3, '大跌': -1.3,
    '重挫': -1.3, '走弱': -1, '走低': -1, '承压': -1, '下行': -1, '风险': -0.9,
    '谨慎': -1, '警惕': -1, '泡沫': -1.3, '高估': -1.1, '估值压力': -1.1,
    '不及预期': -1.3, '低于预期': -1.2, '暴雷': -1.4, '减持': -1, '解禁': -0.9,
    '缩量': -0.9, '套牢': -1.2, '亏损': -1.1, '割肉': -1.2, '恐慌': -1.3,
    '踩踏': -1.3, '抛压': -1.1, '抛售': -1.1, '资金流出': -1.1, '净流出': -1,
    '收紧': -1, '业绩下滑': -1.2, '盈利承压': -1.1, '需求疲软': -1.1,
    '产能过剩': -1.1, '价格战': -1, '退潮': -1.1, '分歧': -0.6, '冰点': -1.2,
    '亏钱效应': -1.2, '情绪转弱': -1.2, '避险': -1, '防守': -0.7, '观望': -0.7,
    '减仓': -1.1, '清仓': -1.2, '止损': -1.1, '不确定性': -0.9, '弱势': -1.1,
    '疲弱': -1.1, '新低': -1.1, '阴跌': -1.2, '回落': -0.8, '震荡走弱': -1.1,

    /* 评论区口语表达（依据 2026-11-18 真实评论语料补充，词典版本 v2）
       只收录字面即带涨跌/盈亏方向的表达；不收录数字梗与需反讽理解的说法。 */
    '时来运转': 0.9, '一路长虹': 1.0, '八方来财': 0.9, '翻盘': 0.9,
    '借你吉言': 0.7, '大阳线': 1.1, '高开高走': 1.2, '否极泰来': 0.9,
    '发发发': 0.6, '發發發': 0.6, '好运连连': 0.7, '长红': 0.8,
    '大阴线': -1.1, '跌成狗': -1.2, '跌沟里': -1.1, '还要跌': -1.2,
    '还会跌': -1.1, '赶紧撤离': -1.2, '逃命': -1.3, '没有量': -0.9,
    '诱多': -1.1, '出货': -0.8, '销户': -1.2, '绝望': -1.2,
    '打退堂鼓': -1.0, '杀到底': -1.1, '高开低走': -1.2, '低开': -0.7,
    '救救我': -0.8, '蒙错': -0.8, '一路向下': -1.1
  };

  const NEGATIONS = ['不', '没', '无', '未', '别', '莫', '难以', '未必', '并非', '尚未', '不算', '很难'];
  const INTENSIFIERS = [
    { words: ['大幅', '明显', '显著', '强烈', '极度', '严重', '全面', '持续', '暴涨', '暴跌', '疯狂', '加速'], factor: 1.5 },
    { words: ['小幅', '略有', '略微', '可能', '或许', '阶段性', '短期', '局部', '边际', '温和', '暂时'], factor: 0.6 }
  ];
  const CONTRASTS = ['但是', '但', '不过', '然而', '只是', '却', '尽管如此', '尽管'];
  const HEDGES = ['如果', '假如', '若', '除非', '？', '?', '会不会', '能否'];
  const THRESHOLD = 0.12;

  /* ---------------- 板块词典 ---------------- */
  // 同一段文本命中多个板块时，会在各板块各计一次样本（口径说明中已披露）
  const SECTORS = [
    { id: 'tech', name: '科技半导体', words: ['半导体', '芯片', '晶圆', '光刻', '封测', '存储芯片', '国产芯片', '算力', '光模块', '消费电子', '科创', '科技股', '人工智能', 'AI', '电子', 'PCB'] },
    { id: 'bank', name: '银行', words: ['银行', '大行', '股份制银行', '城商行', '息差', '存款', '信贷', '央行', '降准', '降息'] },
    { id: 'broker', name: '券商', words: ['券商', '证券', '两融', '成交额', '经纪', '投行', '注册制', '印花税'] },
    { id: 'newenergy', name: '新能源', words: ['新能源', '光伏', '锂电', '储能', '风电', '电池', '逆变器', '硅料'] },
    { id: 'auto', name: '汽车', words: ['汽车', '整车', '车企', '智驾', '自动驾驶', '造车新势力', '车市'] },
    { id: 'pharma', name: '医药', words: ['医药', '创新药', 'CXO', '集采', '医疗器械', '生物医药', '中药'] },
    { id: 'consumer', name: '消费', words: ['白酒', '消费', '食品饮料', '家电', '旅游', '免税', '餐饮', '零售'] },
    { id: 'property', name: '地产', words: ['地产', '房地产', '房企', '楼市', '建材', '竣工', '保交楼'] },
    { id: 'military', name: '军工', words: ['军工', '国防', '船舶', '航空航天', '导弹'] },
    { id: 'resources', name: '有色资源', words: ['有色', '铜', '铝', '黄金', '稀土', '锂矿', '煤炭', '石油', '资源股'] },
    { id: 'utility', name: '公用事业', words: ['电力', '公用事业', '水电', '火电', '核电', '燃气', '高速公路'] },
    { id: 'broad', name: '大盘整体', words: ['大盘', '指数', 'A股', '沪指', '创业板', '全市场', '沪深300', '上证', '市场整体', '两市'] }
  ];

  const PLATFORMS = [
    { id: 'douyin', name: '抖音' },
    { id: 'wechat', name: '公众号' },
    { id: 'video', name: '视频号' },
    { id: 'xiaohongshu', name: '小红书' }
  ];

  /* ---------------- 工具 ---------------- */
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function round1(v) { return Math.round(v * 10) / 10; }

  function clean(text) {
    return String(text || '')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/@[\w\u4e00-\u9fa5-]{1,20}/g, ' ')
      .replace(/\[[^\]]{1,8}\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function splitByContrast(text) {
    let parts = [text];
    for (const marker of CONTRASTS) {
      const next = [];
      for (const part of parts) {
        const idx = part.indexOf(marker);
        if (idx >= 0) next.push(part.slice(0, idx), part.slice(idx + marker.length));
        else next.push(part);
      }
      parts = next;
    }
    return parts;
  }

  function localModifier(text, pos, termLen) {
    const before = text.slice(Math.max(0, pos - 4), pos);
    let factor = 1;
    for (const group of INTENSIFIERS) {
      if (group.words.some((w) => before.includes(w))) { factor = group.factor; break; }
    }
    const negated = NEGATIONS.some((w) => before.slice(-3).includes(w));
    return { factor, negated };
  }

  /* ---------------- 单条文本打分 ---------------- */
  function scoreText(rawText) {
    const text = clean(rawText);
    if (!text) return { score: 0, label: 'neutral', hits: [] };

    const parts = splitByContrast(text);
    let raw = 0;
    const hits = [];

    parts.forEach((part, i) => {
      // 转折后是主要观点：最后一段权重更高
      const partWeight = parts.length > 1 ? (i === parts.length - 1 ? 1.6 : 0.45) : 1;
      for (const [term, base] of Object.entries(LEXICON)) {
        let from = 0;
        let pos;
        while ((pos = part.indexOf(term, from)) !== -1) {
          const { factor, negated } = localModifier(part, pos, term.length);
          let val = base * factor * partWeight;
          if (negated) val = -val * 0.85;
          raw += val;
          hits.push({ term, val: round1(val), negated });
          from = pos + term.length;
        }
      }
    });

    if (HEDGES.some((h) => text.includes(h))) raw *= 0.7;

    // 长文按信息量压缩，避免堆词把分数推到极值
    const divisor = text.length > 90 ? 3.2 : 1.5;
    const score = clamp(Math.tanh(raw / divisor), -1, 1);
    const label = score > THRESHOLD ? 'optimistic' : score < -THRESHOLD ? 'pessimistic' : 'neutral';
    return { score: round1(score * 100) / 100, label, hits };
  }

  function sectorsOf(rawText) {
    const text = clean(rawText);
    const ids = SECTORS.filter((s) => s.words.some((w) => text.includes(w))).map((s) => s.id);
    return ids.length ? ids : ['broad'];
  }

  /* ---------------- 占比口径 ---------------- */
  // 悲观 + 乐观 = 100%（排除中性后重新归一化）；neutral 单独给原始占比
  function ratio(counts) {
    const { optimistic = 0, pessimistic = 0, neutral = 0 } = counts;
    const total = optimistic + pessimistic + neutral;
    const effective = optimistic + pessimistic;
    return {
      optimistic: effective ? round1((optimistic / effective) * 100) : 0,
      pessimistic: effective ? round1((pessimistic / effective) * 100) : 0,
      neutralShare: total ? round1((neutral / total) * 100) : 0,
      samples: total,
      effective: effective,
      counts: { optimistic, pessimistic, neutral }
    };
  }

  function emptyCounts() { return { optimistic: 0, pessimistic: 0, neutral: 0 }; }
  function addCount(counts, label) { counts[label] = (counts[label] || 0) + 1; }

  /* ---------------- 主分析 ---------------- */
  function analyze(input, options) {
    const opts = Object.assign({ creatorWeight: 0.5, commentWeight: 0.5, minSectorSamples: 3 }, options || {});
    const creators = Array.isArray(input.creators) ? input.creators : [];
    const date = input.date || new Date().toISOString().slice(0, 10);

    const creatorCounts = emptyCounts();
    const commentCounts = emptyCounts();
    const sectorCounts = {};
    const platformCounts = {};
    const creatorRows = [];
    SECTORS.forEach((s) => { sectorCounts[s.id] = emptyCounts(); });
    PLATFORMS.forEach((p) => { platformCounts[p.id] = emptyCounts(); });

    let commentTotal = 0;

    creators.forEach((c, index) => {
      const content = scoreText(c.text || '');
      const cSectors = sectorsOf(c.text || '');
      addCount(creatorCounts, content.label);
      cSectors.forEach((sid) => addCount(sectorCounts[sid], content.label));
      const pid = PLATFORMS.some((p) => p.id === c.platform) ? c.platform : 'douyin';
      addCount(platformCounts[pid], content.label);

      const comments = Array.isArray(c.comments) ? c.comments : [];
      const cc = emptyCounts();
      const commentSectors = {};
      comments.forEach((item) => {
        const txt = typeof item === 'string' ? item : (item && item.text) || '';
        if (!txt) return;
        const cs = scoreText(txt);
        addCount(commentCounts, cs.label);
        addCount(cc, cs.label);
        sectorsOf(txt).forEach((sid) => {
          if (!commentSectors[sid]) commentSectors[sid] = emptyCounts();
          addCount(commentSectors[sid], cs.label);
          if (!sectorCounts[sid]) sectorCounts[sid] = emptyCounts();
          addCount(sectorCounts[sid], cs.label);
        });
        commentTotal += 1;
      });

      creatorRows.push({
        id: c.id || 'c' + (index + 1),
        name: c.name || '未命名创作者',
        platform: pid,
        followers: Number(c.followers) || 0,
        rank: Number(c.rank) || index + 1,
        publishedAt: c.publishedAt || '',
        text: clean(c.text || ''),
        label: content.label,
        score: content.score,
        sectors: cSectors,
        commentCount: comments.length,
        commentRatio: ratio(cc),
        commentLabel: dominantLabel(cc)
      });
    });

    const cr = ratio(creatorCounts);
    const cor = ratio(commentCounts);
    const wSum = (opts.creatorWeight + opts.commentWeight) || 1;
    const wc = opts.creatorWeight / wSum;
    const wm = opts.commentWeight / wSum;
    const overallOptimistic = round1(cr.optimistic * wc + cor.optimistic * wm);

    /* 以「全部样本」为统一分母的三分占比：悲观 + 乐观 + 中性 = 100%。
       自 v6 起这是主指标：三类在同一分母下可直接相加，且不会把
       占多数的中性样本隐藏起来。optimistic / pessimistic 保留为
       「有倾向表述内部」的辅助口径，分母不同，不能与三分数相加。 */
    const sampleCounts = {
      pessimistic: (cr.counts.pessimistic || 0) + (cor.counts.pessimistic || 0),
      optimistic: (cr.counts.optimistic || 0) + (cor.counts.optimistic || 0),
      neutral: (cr.counts.neutral || 0) + (cor.counts.neutral || 0)
    };
    const absTotal = sampleCounts.pessimistic + sampleCounts.optimistic + sampleCounts.neutral;
    const shareOfAll = (n) => absTotal ? round1(n / absTotal * 100) : 0;
    const bearAll = shareOfAll(sampleCounts.pessimistic);
    const bullAll = shareOfAll(sampleCounts.optimistic);
    // 末项用补数，保证三者严格合计 100%（避免逐项四舍五入产生 ±0.1）
    const neutralAll = round1(100 - bearAll - bullAll);

    const overall = {
      optimistic: overallOptimistic,
      pessimistic: round1(100 - overallOptimistic),
      // 兼容旧字段：内容侧与评论侧「各自中性率」的等权平均，不对应任何绝对条数
      neutralShare: round1((cr.neutralShare * wc) + (cor.neutralShare * wm)),
      neutralShareOfAll: neutralAll,
      sampleCounts: sampleCounts,
      allSampleShares: {
        pessimistic: bearAll, optimistic: bullAll, neutral: neutralAll
      },
      // 分侧中间量，供说明文案做可验证的推理链
      creatorShares: {
        optimistic: cr.optimistic, pessimistic: cr.pessimistic,
        neutralShare: cr.neutralShare, effective: cr.effective, samples: cr.samples
      },
      commentShares: {
        optimistic: cor.optimistic, pessimistic: cor.pessimistic,
        neutralShare: cor.neutralShare, effective: cor.effective, samples: cor.samples
      },
      creatorOptimistic: cr.optimistic,
      commentOptimistic: cor.optimistic,
      creatorSamples: cr.samples,
      commentSamples: cor.samples,
      effectiveSamples: cr.effective + cor.effective,
      totalSamples: cr.samples + cor.samples,
      divergence: round1(cr.optimistic - cor.optimistic),
      confidence: confidenceOf(cr, cor, platformCounts),
      weights: { creator: round1(wc * 100), comment: round1(wm * 100) }
    };

    const sectors = SECTORS.map((s) => {
      const r = ratio(sectorCounts[s.id] || emptyCounts());
      return {
        id: s.id, name: s.name,
        optimistic: r.optimistic, pessimistic: r.pessimistic,
        neutralShare: r.neutralShare, samples: r.samples, effective: r.effective,
        counts: r.counts,
        dominant: r.optimistic >= r.pessimistic ? 'optimistic' : 'pessimistic',
        lowSample: r.samples < opts.minSectorSamples,
        // 有倾向的样本数才是「方向集中」结论可依赖的基数
        lowEffective: r.effective < opts.minSectorSamples
      };
    }).sort((a, b) => b.samples - a.samples);

    const platforms = PLATFORMS.map((p) => {
      const r = ratio(platformCounts[p.id] || emptyCounts());
      const creatorsOnPlatform = creatorRows.filter((c) => c.platform === p.id).length;
      return {
        id: p.id, name: p.name,
        optimistic: r.optimistic, pessimistic: r.pessimistic,
        samples: r.samples, creators: creatorsOnPlatform,
        commentSamples: creatorRows.filter((c) => c.platform === p.id)
          .reduce((n, c) => n + c.commentCount, 0)
      };
    });

    const notes = buildNotes(overall, sectors, platforms, input, opts);

    return {
      schemaVersion: 1,
      date: date,
      generatedAt: input.generatedAt || new Date().toISOString(),
      sourceLabel: input.sourceLabel || '未标注数据源',
      isDemo: !!input.isDemo,
      coverageNote: input.coverageNote || '',
      overall: overall,
      sectors: sectors,
      platforms: platforms,
      creators: creatorRows.sort((a, b) => a.rank - b.rank),
      commentTotal: commentTotal,
      notes: notes,
      methodology: {
        polarity: '中文财经措辞词典 + 否定 / 程度 / 转折 / 疑问修饰，得分经 tanh 压缩到 [-1,1]，阈值 ±0.12',
        ratio: '主指标为以全部样本为统一分母的悲观/乐观/中性三分占比（合计 100%，按绝对条数计算）；辅助口径为有明确倾向表述内部的悲观/乐观二分（合计 100%，内容侧与评论侧各算占比后等权合并）。两组分母不同，不可相加',
        weighting: '主播内容与评论区先各自算占比，再按设定权重合并，避免评论条数主导结果',
        sector: '按关键词命中归板块，一条文本命中多个板块时各计一次；未点名具体板块的归入「大盘整体」且不参与方向比较；方向集中按绝对条数排序，并要求可比板块至少 2 个且各有足够有效倾向样本，不足时不给结论',
        confidence: '由有效样本量（60%）与平台覆盖数（40%）合成，仅表示统计稳定性，不代表预测准确度',
        boundary: '仅统计公开内容的措辞倾向，不等于市场情绪或行情走势；不含行情数据，不预测涨跌，不构成任何操作建议，也不作为任何交易决策依据'
      }
    };
  }

  function dominantLabel(counts) {
    if (!counts || !counts.optimistic && !counts.pessimistic) return 'neutral';
    return counts.optimistic >= counts.pessimistic ? 'optimistic' : 'pessimistic';
  }

  function confidenceOf(cr, cor, platformCounts) {
    const n = cr.effective + cor.effective;
    const size = Math.min(1, n / 150);
    const covered = PLATFORMS.filter((p) => (platformCounts[p.id] || {}).optimistic ||
      (platformCounts[p.id] || {}).pessimistic || (platformCounts[p.id] || {}).neutral).length;
    return Math.round((size * 0.6 + (covered / PLATFORMS.length) * 0.4) * 100);
  }

  function buildNotes(overall, sectors, platforms, input, opts) {
    const notes = [];
    const sc = overall.sampleCounts;
    const cs = overall.creatorShares;
    const ms = overall.commentShares;
    const a = overall.allSampleShares;
    notes.push('共统计 ' + overall.totalSamples + ' 条样本（内容 ' + overall.creatorSamples +
      ' 条 / 评论 ' + overall.commentSamples + ' 条）：悲观 ' + sc.pessimistic +
      ' 条、乐观 ' + sc.optimistic + ' 条、中性 ' + sc.neutral +
      ' 条，其中 ' + overall.effectiveSamples + ' 条有明确倾向。');
    notes.push('主指标是「全部样本三分占比」：悲观 ' + a.pessimistic + '% / 乐观 ' +
      a.optimistic + '% / 中性 ' + a.neutral + '%，三者以全部 ' + overall.totalSamples +
      ' 条样本为同一分母，合计 100%。本期中性占 ' + a.neutral +
      '%，即多数表述未呈现可判定的方向倾向，应结合有倾向样本量一起解读。');
    const commentShare = overall.totalSamples
      ? round1(overall.commentSamples / overall.totalSamples * 100) : 0;
    notes.push('样本构成：评论占 ' + commentShare + '%（' + overall.commentSamples + ' / ' +
      overall.totalSamples + ' 条）、主播内容占 ' + round1(100 - commentShare) +
      '%。主指标按绝对条数计算，因此主要反映评论区措辞，不代表全体市场参与者的看法。');
    notes.push('辅助口径是「有明确倾向表述内部」的二分占比：内容侧 ' + cs.effective +
      ' 条倾向样本中悲观 ' + cs.pessimistic + '% / 乐观 ' + cs.optimistic +
      '%，评论侧 ' + ms.effective + ' 条中悲观 ' + ms.pessimistic + '% / 乐观 ' +
      ms.optimistic + '%；两侧各占 50% 权重合并为悲观 ' + overall.pessimistic +
      '% / 乐观 ' + overall.optimistic + '%，两者合计 100%。先分侧再等权合并是为了避免' +
      '评论条数压倒主播内容；它的分母只有 ' + overall.effectiveSamples +
      ' 条，与主指标分母不同，不能相加。');

    /* 「大盘整体」是兜底归类，不参与方向比较。
       早期版本按「板块内占比」排序且无条件下取第一名，有两个问题：
       1) 所有板块乐观占比都为 0 时，会把 0% 乐观的板块写成「乐观最集中」；
       2) 悲观与乐观占比互补（合计 100%），一两条样本就能被放大成 100%。
       现改为按绝对条数排序，并要求每个板块有足够有效倾向样本、至少 2 个可比板块；
       不满足时如实说明样本不足，不给方向结论。 */
    const minSector = (opts && opts.minSectorSamples) || 3;
    const comparable = sectors.filter((s) =>
      s.id !== 'broad' && !s.lowSample && !s.lowEffective);
    const absCount = (s, key) => (s.counts && Number(s.counts[key])) || 0;
    const bearPool = comparable.filter((s) => absCount(s, 'pessimistic') > 0);
    const bullPool = comparable.filter((s) => absCount(s, 'optimistic') > 0);
    const byBear = bearPool.slice().sort((a, b) =>
      absCount(b, 'pessimistic') - absCount(a, 'pessimistic') || b.samples - a.samples)[0];
    const byBull = bullPool.slice().sort((a, b) =>
      absCount(b, 'optimistic') - absCount(a, 'optimistic') || b.samples - a.samples)[0];

    if (comparable.length < 2) {
      notes.push('本期点名具体板块的有效样本不足：可比板块仅 ' + comparable.length +
        ' 个（需至少 2 个，且每个有效倾向样本不少于 ' + minSector +
        ' 条），暂不判定悲观 / 乐观的方向集中。');
    } else {
      if (byBear) notes.push('悲观表述条数最多的方向：' + byBear.name + '（悲观 ' +
        absCount(byBear, 'pessimistic') + ' 条，该板块有效倾向样本 ' + byBear.effective +
        ' 条，板块内悲观占 ' + byBear.pessimistic + '%）。');
      else notes.push('本期可比板块中未出现悲观表述，暂不判定悲观方向集中。');
      if (byBull) notes.push('乐观表述条数最多的方向：' + byBull.name + '（乐观 ' +
        absCount(byBull, 'optimistic') + ' 条，该板块有效倾向样本 ' + byBull.effective +
        ' 条，板块内乐观占 ' + byBull.optimistic + '%）。');
      else notes.push('本期可比板块中未出现乐观表述，暂不判定乐观方向集中。');
    }

    const broad = sectors.find((s) => s.id === 'broad');
    if (broad) {
      const share = overall.totalSamples
        ? round1(broad.samples / overall.totalSamples * 100) : 0;
      notes.push('板块归类说明：' + broad.samples + ' / ' + overall.totalSamples +
        ' 条样本（' + share + '%）未点名具体板块，归入「大盘整体」兜底类且不参与方向比较' +
        (share >= 60 ? '；本期板块维度样本偏少，仅供参考。' : '。'));
    }

    if (Math.abs(overall.divergence) >= 25) {
      notes.push('主播内容与评论区乐观占比相差 ' + Math.abs(overall.divergence) +
        ' 个百分点，两侧表述出现明显分歧（' + (overall.divergence > 0 ? '主播更偏乐观' : '评论区更偏乐观') + '）。');
    }
    if (overall.confidence < 60) notes.push('样本量或平台覆盖不足，当前占比的统计稳定性偏低，请谨慎解读。');
    if (input.coverageNote) notes.push('数据源覆盖说明：' + input.coverageNote);
    notes.push('以上仅为公开内容措辞的统计结果，不等于市场情绪或行情走势，不能作为任何交易决策依据，也不构成任何操作建议。');
    return notes;
  }

  /* ---------------- 演示数据（明确标注，非真实市场数据） ---------------- */
  // 化名 + 泛化表述，不含真实主播、具体个股与真实行情数字
  const DEMO_TEMPLATES = {
    tech: {
      bull: ['半导体国产替代进度继续推进，设备与材料环节的订单能见度改善，估值回落后性价比开始显现。',
        '算力需求带动光模块与先进封装景气回升，板块经历调整后，资金开始关注业绩确定性。'],
      bear: ['科技半导体前期涨幅较大，估值压力仍在，短期获利盘抛压与分歧明显，注意回撤风险。',
        '芯片板块成交缩量、情绪转弱，若需求不及预期，高估值品种仍有调整压力。']
    },
    bank: {
      bull: ['银行板块高股息与低估值属性在震荡环境中具备配置价值，息差压力边际缓和，防御属性突出。',
        '降准预期下信贷投放有望改善，大行分红稳定，红利资产的确定性获得资金青睐。'],
      bear: ['银行息差持续承压，信贷需求疲软，若资产质量出现波动，估值修复空间有限。']
    },
    broad: {
      bull: ['两市成交额温和回升，指数在关键位置企稳，政策支持下市场情绪回暖，赚钱效应逐步修复。',
        '大盘经历缩量整理后放量突破，增量资金入场，超跌反弹的持续性值得跟踪。'],
      bear: ['大盘冲高回落，量能不济，板块分歧加大，短期不确定性上升，建议保持谨慎。',
        '指数走弱、避险情绪抬头，亏钱效应扩散，观望资金增多，需警惕进一步回调。']
    },
    newenergy: {
      bull: ['储能招标超预期，产业链价格企稳，行业盈利修复的拐点逐步清晰。'],
      bear: ['光伏产能过剩与价格战尚未结束，盈利承压，板块仍在寻底。']
    },
    consumer: {
      bull: ['消费板块估值处于低位，政策支持下需求边际回暖，龙头业绩改善。'],
      bear: ['消费需求疲软，白酒动销低于预期，短期仍以观望为主。']
    },
    broker: {
      bull: ['成交额回升带动券商经纪与两融业务改善，板块弹性值得关注。'],
      bear: ['券商板块跟随市场缩量走弱，缺乏独立催化，短期承压。']
    },
    property: {
      bull: ['地产政策持续优化，核心城市销售企稳，竣工链出现边际改善。'],
      bear: ['房企现金流压力仍在，销售数据不及预期，板块基本面尚未见底。']
    },
    pharma: {
      bull: ['创新药出海订单超预期，集采影响边际减弱，板块估值修复空间打开。'],
      bear: ['医药板块业绩下滑与集采压力并存，资金持续流出，情绪偏弱。']
    },
    auto: {
      bull: ['智驾渗透率提升带动整车与零部件需求，车企订单饱满，景气延续。'],
      bear: ['车市价格战加剧，产能过剩压制盈利，板块短期承压。']
    },
    resources: {
      bull: ['黄金与铜价走强，资源股盈利改善，资金流入明显。'],
      bear: ['有色板块前期涨幅较大，需求预期转弱，存在回调风险。']
    }
  };

  const DEMO_COMMENTS = {
    bull: ['这次说得有道理，估值确实不贵了', '已经企稳了，可以慢慢看', '政策面在改善，情绪回暖',
      '超跌反弹应该还能延续', '低估值品种性价比出来了', '资金在回流，别太悲观',
      '拿住了，等业绩验证', '这个位置我偏乐观'],
    bear: ['别太乐观，量能还是不够', '又是套牢的一周', '感觉还要跌，先观望',
      '高估的问题没解决，谨慎点', '每次反弹都是减仓机会', '需求没起来，别接飞刀',
      '亏怕了，不敢加仓', '缩量说明没人愿意买'],
    neutral: ['观望，等数据出来再说', '不好说，看后续量能', '记录一下，明天再看',
      '结构分化，不能一概而论', '有没有更详细的数据？', '先不表态']
  };

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function dateSeed(date) {
    let h = 2166136261;
    for (const ch of String(date)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function generateDemo(date) {
    const rnd = mulberry32(dateSeed(date));
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const platformPlan = [
      ...Array(8).fill('douyin'), ...Array(4).fill('wechat'),
      ...Array(3).fill('video'), ...Array(5).fill('xiaohongshu')
    ];
    const sectorIds = ['tech', 'bank', 'broad', 'newenergy', 'consumer', 'broker', 'property', 'pharma', 'auto', 'resources'];
    const sectorName = Object.fromEntries(SECTORS.map((s) => [s.id, s.name]));

    const creators = platformPlan.map((platform, i) => {
      const sid = i < 8 ? 'tech' : (i < 13 ? 'bank' : pick(sectorIds));
      const pool = DEMO_TEMPLATES[sid] || DEMO_TEMPLATES.broad;
      // 演示分布：科技半导体偏悲观、银行偏乐观，其余按伪随机
      const bull = sid === 'tech' ? rnd() < 0.22 : sid === 'bank' ? rnd() < 0.8 : rnd() < 0.45;
      let text = pick(bull ? pool.bull : pool.bear);
      if (i % 3 === 0) text = '【' + sectorName[sid] + '】' + text;
      if (i % 4 === 0) text += '整体来看，' + (bull ? '大盘企稳后仍有修复空间。' : '大盘不确定性仍在，保持谨慎。');

      const nComments = 4 + Math.floor(rnd() * 7);
      const comments = [];
      for (let k = 0; k < nComments; k++) {
        // 评论区整体比主播略悲观
        const r = rnd();
        const tone = r < 0.28 ? 'bull' : r < 0.78 ? 'bear' : 'neutral';
        let text = pick(DEMO_COMMENTS[tone]);
        // 约六成评论带上板块词，使板块维度的样本量可解释
        if (rnd() < 0.6) text = sectorName[sid] + '这块，' + text;
        comments.push({ text: text });
      }
      return {
        id: 'demo_' + (i + 1),
        name: '演示创作者 ' + String.fromCharCode(65 + (i % 20)),
        platform: platform,
        followers: Math.round((18.6 - i * 0.72) * 100000) / 100 * 10000,
        rank: i + 1,
        publishedAt: date + 'T' + String(8 + (i % 12)).padStart(2, '0') + ':30:00+08:00',
        text: text,
        comments: comments
      };
    });

    return {
      date: date,
      generatedAt: date + 'T18:30:00+08:00',
      sourceLabel: '内置演示样例（非真实采集数据）',
      isDemo: true,
      coverageNote: '演示数据用于展示产品形态与计算口径，不对应任何真实主播、真实内容或真实市场情绪。',
      creators: creators
    };
  }

  function generateDemoHistory(endDate, days) {
    const out = [];
    const base = new Date(endDate + 'T00:00:00Z');
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(base.getTime() - i * 86400000).toISOString().slice(0, 10);
      const input = generateDemo(d);
      const snap = analyze(input);
      out.push({ date: d, optimistic: snap.overall.optimistic, pessimistic: snap.overall.pessimistic,
        confidence: snap.overall.confidence, isDemo: true, sourceLabel: snap.sourceLabel });
    }
    return out;
  }

  return {
    analyze, scoreText, sectorsOf, ratio,
    generateDemo, generateDemoHistory,
    SECTORS, PLATFORMS, LEXICON,
    THRESHOLD
  };
});
