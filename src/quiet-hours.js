// 免打扰时段（quiet hours）。
//
// 为什么需要：桥接里有好几条「AI 自己开口」的路径，其中「主动冒泡」是唯一没有任何
// 外部触发、纯靠定时器自己找话说的那条——它也是最容易在半夜把人吵醒的路径。主人给的
// 作息是 22:00–06:30 与 12:50–13:50 两段不能主动开口，且这两个区间会随作息调整。
//
// 设计取舍：
//   · 用「HH:MM 小时:分钟」而不是 epoch 存配置。区间是跟着人作息走的，跨天、跨夏令时、
//     系统时钟被校正都不该让区间错位；代价是每次判定多做几次比较，可以忽略。
//   · 判定是纯函数、不碰全局状态，便于单测覆盖边界（正好 22:00、正好 06:30、跨午夜）。
//   · 端点左闭右开：06:30:00 整已不在区间内，避免「多睡一分钟」这类边界歧义。
//
// 只作用于「主动开口」这一条路径。有人 @、关键词、拍一拍这类被动唤醒不受影响——
// 有人半夜找它，它还是该回。

/** 把 "20:00" / "20：00" / "2000" / "8:05" 解析成当天分钟数（0~1439）；解析不了返回 null。 */
export function parseClockMinutes(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const m = /^(\d{1,2})[:：]?(\d{2})$/.exec(s);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

/** 分钟数还原成 "HH:MM"（用于日志与规范化的落盘值）。 */
export function formatClockMinutes(minutes) {
  const n = ((Number(minutes) % 1440) + 1440) % 1440;
  const hh = Math.floor(n / 60);
  const mm = n % 60;
  return `${hh < 10 ? '0' : ''}${hh}:${mm < 10 ? '0' : ''}${mm}`;
}

/**
 * ranges 形如 [{ start: '20:00', end: '06:30' }]。
 * 命中返回 { start, end, label }（label 形如 "22:00~06:30"，方便日志说清是哪一段）；
 * 未命中返回 null。start > end 表示跨午夜；start === end 视为无效（那不是 24 小时静音）。
 */
export function matchQuietRange(ranges, date = new Date()) {
  if (!Array.isArray(ranges) || !ranges.length) return null;
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return null;
  const now = d.getHours() * 60 + d.getMinutes();
  for (const r of ranges) {
    if (!r || typeof r !== 'object') continue;
    const start = parseClockMinutes(r.start);
    const end = parseClockMinutes(r.end);
    if (start === null || end === null || start === end) continue;
    const hit = start < end ? (now >= start && now < end) : (now >= start || now < end);
    if (hit) return { start, end, label: `${formatClockMinutes(start)}~${formatClockMinutes(end)}` };
  }
  return null;
}

/**
 * 如果 date 落在免打扰区间里，返回距区间结束还有多少毫秒；否则返回 0。
 *
 * 跨午夜必须这样解：23:00 落在 22:00~06:30 里，但「今天 06:30」早就过去了，正确答案
 * 是次日 06:30（约 7.5 小时）。所以从当前分钟起逐分钟向后找第一个出区间的时刻，最多
 * 找 24 小时；找不到（说明区间配错成覆盖全天）按「不拦」返回 0，而不是把人永久卡死。
 */
export function quietMillisLeft(ranges, date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime()) || !matchQuietRange(ranges, d)) return 0;
  const probe = new Date(d.getTime());
  probe.setSeconds(0, 0);
  const base = probe.getTime();
  for (let i = 1; i <= 24 * 60; i++) {
    probe.setTime(base + i * 60000);
    if (!matchQuietRange(ranges, probe)) {
      // 用**原始 date** 而不是对齐到整分的 probe 来计算剩余量：22:59:40 距离 06:30 是
      // 7h30m20s 而不是 7h30m，直接对齐会把每次顺延都提前一点。
      return probe.getTime() - d.getTime();
    }
  }
  return 0;
}

/**
 * 把用户提交的免打扰配置收敛成 [{start:'HH:MM', end:'HH:MM'}]。
 * 接受三种形式：
 *   · [{ start:'22:00', end:'06:30' }, ...]（控制台表单）
 *   · ['22:00-06:30', '12:50~13:50']（短横线 / ~ / ～ / 至 / 到 都认）
 *   · '22:00-06:30\n12:50-13:50'（文本框，按换行/逗号/分号拆）
 *
 * 解析不出来的条目**直接丢弃**而不是抛错或清空整份配置：这是设置项，配错一格不该
 * 把其余几段免打扰一起取消，更不该让「保存设置」这个动作失败。
 */
export function normalizeQuietRanges(input) {
  const raw = [];
  const pushOne = (item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      raw.push({ start: item.start, end: item.end });
      return;
    }
    if (typeof item !== 'string') return;
    for (const part of item.split(/[\n\r,，;；]+/)) {
      const s = part.trim();
      if (!s) continue;
      const m = /^(.+?)\s*(?:-|~|～|至|到)\s*(.+)$/.exec(s);
      if (m) raw.push({ start: m[1], end: m[2] });
    }
  };
  if (Array.isArray(input)) input.forEach(pushOne);
  else pushOne(input);

  const out = [];
  for (const r of raw) {
    const start = parseClockMinutes(r.start);
    const end = parseClockMinutes(r.end);
    if (start === null || end === null || start === end) continue;
    out.push({ start: formatClockMinutes(start), end: formatClockMinutes(end) });
    if (out.length >= 12) break; // 再多基本是配错了，没有继续排的意义
  }
  return out;
}
