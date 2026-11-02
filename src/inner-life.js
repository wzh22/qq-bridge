// 「她自己的状态」：作息、关系进度、以及一份会自己往前走的小生活。
//
// 为什么需要：人格卡定义了「她是谁、怎么说话」，但一个人像不像真人，还取决于她此刻
// 在哪、累不累、今天干了什么、跟对面熟到什么程度。缺了这层，她永远是一个随时待命、
// 永远在线、对所有人都同样热络的存在——这正是最明显的 AI 特征：不是措辞像 AI，
// 而是**没有自己的时间**。
//
// 设计取舍：
//   · 全部是**确定性**的。同样的日期 + 同样的状态算出同样的结果，不依赖 Math.random()。
//     好处：重启、多进程、单元测试都不会漂移；「今天发生了什么」用日期当种子。
//   · 状态推进是**纯函数**：tickLife(state, now) 返回新 state，不碰文件。桥接负责读写
//     state/inner-life.json，这里只算，所以可以脱离桥接单测。
//   · 只影响**语气和主动性**，不影响事实正确性。困了可以话少、回得慢；但困了不能胡说。
//   · 生活内容是**可以不说**的素材，不是必须汇报的日程。每轮都念一遍「我今天种了什么」
//     比不说话还假——所以 prompt 里明确写了「被问到再说」。

// ─────────────────────────────────────────────────────────────
// 一、此刻是什么状态（她自己的作息）
// ─────────────────────────────────────────────────────────────
//
// 区间与免打扰配置对齐（22:00~06:30 睡、12:50~13:50 午休），但不是同一件事：
// 免打扰管的是「能不能主动开口」，这里管的是「醒着的时候什么精神」。
// 有人半夜找她，她还是要回——只是回得像被吵醒的人。

const DAY_PHASES = [
  {
    from: 0, to: 390, key: 'asleep', label: '睡着', energy: 0.1, proactive: 0.15,
    voice: '你正睡着。有人找你才会醒，回话又短又慢、有点没睡醒的黏糊，两三句就想继续睡。'
  },
  {
    from: 390, to: 480, key: 'waking', label: '刚醒', energy: 0.35, proactive: 0.4,
    voice: '你刚醒没多久，脑子还没转起来。说话短、容易答非所问，别装清醒。'
  },
  {
    from: 480, to: 690, key: 'morning', label: '上午清醒', energy: 0.75, proactive: 0.8,
    voice: '上午，你清醒、话也不多，聊正事的状态最好。'
  },
  {
    from: 690, to: 770, key: 'noon_drowsy', label: '中午犯困', energy: 0.4, proactive: 0.35,
    voice: '快到午睡的点，你有点困、有点懒。长话不想说，能一句说完就一句。'
  },
  {
    from: 770, to: 830, key: 'nap', label: '午睡', energy: 0.15, proactive: 0.2,
    voice: '你在午睡。被吵醒会有点小情绪（但不会凶人），回得又短又敷衍，想接着睡。'
  },
  {
    from: 830, to: 870, key: 'nap_wake', label: '午睡刚醒', energy: 0.45, proactive: 0.5,
    voice: '刚睡醒，人还迷糊着，说话有点慢半拍。'
  },
  {
    from: 870, to: 1050, key: 'afternoon', label: '下午', energy: 0.7, proactive: 0.75,
    voice: '下午，正常状态，聊什么都行。'
  },
  {
    from: 1050, to: 1140, key: 'dinner', label: '晚饭时间', energy: 0.65, proactive: 0.6,
    voice: '晚饭前后，你有点懒散、心思不完全在聊天上，回得随意。'
  },
  {
    from: 1140, to: 1320, key: 'evening', label: '晚上精神最好', energy: 1, proactive: 1,
    voice: '这是你一天里精神最好的时候，话最多、最愿意接梗、最愿意开话题。'
  },
  {
    from: 1320, to: 1440, key: 'sleepy', label: '困了但还醒着', energy: 0.4, proactive: 0.45,
    voice: '你已经困了，只是还没睡。话变少、开始敷衍、偶尔冒一句睡意，别硬撑着长篇大论。'
  }
];

/** 当前时刻落在哪个作息阶段。返回 { key, label, energy, proactive, voice }。 */
export function describeSelfState(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return DAY_PHASES[2];
  const minutes = d.getHours() * 60 + d.getMinutes();
  for (const p of DAY_PHASES) {
    if (minutes >= p.from && minutes < p.to) return p;
  }
  return DAY_PHASES[2];
}

/** 星期几的中文说法（她说话不会用「周三」，用「星期三」）。 */
export function weekdayText(date = new Date()) {
  const names = ['日', '一', '二', '三', '四', '五', '六'];
  return `星期${names[date.getDay()]}`;
}

// ─────────────────────────────────────────────────────────────
// 二、关系进度（按累计消息数分档）
// ─────────────────────────────────────────────────────────────
//
// 为什么要量化：人格卡里「不熟的人 / 熟人」是定性描述，模型只能靠感觉判断，结果就是
// 对聊了三千句的人和第一天来的人用同一套语气。给一个可累加的数字，档位才会真的往上走。
//
// 只数**对方发来的**消息：数自己说了多少句会奖励话痨，数对方发了多少才是「关系」。

const RELATION_TIERS = [
  {
    upTo: 30, name: '刚认识',
    stance: '客气、话少，不主动问私事、不掏心。对方问什么答什么，不追问。'
  },
  {
    upTo: 100, name: '眼熟',
    stance: '记得住对方说过的基本信息，可以顺着上次的话题接一句，但还不主动开话题。'
  },
  {
    upTo: 250, name: '聊得来',
    stance: '能开玩笑了，可以主动接话、偶尔吐槽一句；仍然不问私事。'
  },
  {
    upTo: 600, name: '熟人',
    stance: '可以主动开话题、拿共同聊过的事当谈资，说话随意一些，不用每句都客气。'
  },
  {
    upTo: 1200, name: '老熟人',
    stance: '可以互损、可以记得他以前的偏好和雷点，主动找他的时候不用铺垫。'
  },
  {
    upTo: 2500, name: '好朋友',
    stance: '会主动惦记他、他久没说话可以问一句；可以聊到情绪和烦恼，但私事仍然看他愿不愿意说。'
  },
  {
    upTo: 5000, name: '很亲近',
    stance: '说话不必收敛，可以撒娇、可以抱怨、可以直说自己的看法；他难受时你会真的在意。'
  },
  {
    upTo: Infinity, name: '无话不说',
    stance: '像处了很久的人，不用客套也不用演；沉默和冷场都不尴尬，想说什么说什么。'
  }
];

/**
 * 累计消息数 → 关系档位。
 * 返回 { index, name, stance, prev, next, progress }，progress 是当前档位内的进度 0~1
 * （用于「快到下一档」这种语气，以及日志）。
 */
export function relationTier(total = 0) {
  const n = Math.max(0, Math.floor(Number(total) || 0));
  let prev = 0;
  for (let i = 0; i < RELATION_TIERS.length; i++) {
    const t = RELATION_TIERS[i];
    if (n < t.upTo) {
      const span = t.upTo === Infinity ? 0 : Math.max(1, t.upTo - prev);
      return {
        index: i,
        name: t.name,
        stance: t.stance,
        prev,
        next: t.upTo === Infinity ? null : t.upTo,
        progress: t.upTo === Infinity ? 1 : Math.min(1, (n - prev) / span)
      };
    }
    prev = t.upTo;
  }
  const last = RELATION_TIERS[RELATION_TIERS.length - 1];
  return { index: RELATION_TIERS.length - 1, name: last.name, stance: last.stance, prev, next: null, progress: 1 };
}

// ─────────────────────────────────────────────────────────────
// 三、她自己的小生活（会按天往前走）
// ─────────────────────────────────────────────────────────────
//
// 三件小事，全部有连续性，不是每天随机一句空话：
//   · 农场：三块地，种下去要等几天才熟，熟了要收，收了要补种——所以「我的萝卜熟了」
//     这句话只可能在真的种了三天之后说出口。
//   · 海：每天游一趟，遇到什么用日期定，偶尔捡到能送人的东西。
//   · 爬塔：一局一局往上打，会死、会重开，进度条不会回退到零。
//
// 为什么不写成随机句子：随机句子每天都是新的、互不相干，聊两次就露馅（上周说的农场
// 这周不见了）。这里的状态是**存下来**的，所以下周问她「你那个玉米呢」她答得上来。

const CROPS = [
  { name: '番茄', days: 4 },
  { name: '玉米', days: 5 },
  { name: '萝卜', days: 3 },
  { name: '蓝莓', days: 4 },
  { name: '向日葵', days: 5 },
  { name: '黄瓜', days: 3 }
];

const SEA_FINDS = [
  '捡到一个完整的贝壳',
  '被一只水母蹭了一下，有点麻',
  '看见海面上有个塑料袋，捞起来扔了',
  '遇到一群小鱼，跟着游了一段',
  '什么都没捡到，就游了两圈',
  '在礁石缝里看见一只小螃蟹',
  '捡到一个空的漂流瓶，里面没信',
  '海面很平，躺着漂了一会儿'
];

const GAME_EVENTS = [
  '一路顺风，没掉血',
  '被一组精英怪揍了，掉了不少血',
  '捡到一张特别好用的牌',
  '手滑点错，亏了一瓶药',
  '运气不错，宝箱开出了好东西',
  '卡组太厚，抽不到关键牌'
];

/** 本地日期字符串 YYYY-MM-DD（不用 UTC，避免早上八点前算成前一天）。 */
export function dayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 两个 YYYY-MM-DD 之间差几天（b - a）。 */
export function daysBetween(a, b) {
  const pa = Date.parse(`${String(a)}T00:00:00`);
  const pb = Date.parse(`${String(b)}T00:00:00`);
  if (!Number.isFinite(pa) || !Number.isFinite(pb)) return 0;
  return Math.round((pb - pa) / 86400000);
}

/** FNV-1a：给「日期 + 名称」算一个稳定的小整数，当确定性随机数用。 */
function hashSeed(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickBy(list, seed) {
  if (!Array.isArray(list) || !list.length) return null;
  return list[seed % list.length];
}

/** 一块地到期没有：种下第 grow 天当天可收。 */
function isRipe(plot, today) {
  if (!plot || !plot.crop) return false;
  const crop = CROPS.find((c) => c.name === plot.crop);
  const growDays = Number(plot.days) || (crop ? crop.days : 4);
  return daysBetween(plot.plantedDay, today) >= growDays;
}

/** 新建一份初始生活状态（第一天进这个模块时用）。 */
export function initialLifeState(now = new Date()) {
  const today = dayKey(now);
  const plots = [];
  // 初始的地不是今天刚种下的：她本来就过着日子，第一次接上就显示「三块地全是今天种的、
  // 爬塔第 1 层」会像刚开局，一看就是程序初始化出来的。这里按种子回拨几天，
  // 让第一次看到的农场就处在「有的快熟了、有的刚种」的自然状态。
  for (let i = 0; i < 3; i++) {
    const crop = pickBy(CROPS, hashSeed(`plot0|${i}`));
    const back = hashSeed(`planted|${i}`) % Math.max(1, crop.days);
    plots.push({
      crop: crop.name,
      plantedDay: addDays(today, -back),
      days: crop.days
    });
  }
  // 爬塔同理：她已经在玩了，不是今天第一次打开。给一个 6~19 层的初始进度，
  // 最好成绩不低于当前层（否则「当前 12 层、最好 8 层」自相矛盾）。
  const floor = 6 + (hashSeed('tower0') % 14);
  return {
    version: 1,
    // 故意记成「昨天」：这样紧接着的那次 tickLife 会真的往前推一天，而不是因为
    // lastTickDay === today 就原地返回空事件（第一次接上就什么都没发生，看着像没生效）。
    lastTickDay: addDays(today, -1),
    farm: { plots, harvested: hashSeed('harvested0') % 9 },
    tower: { floor, best: floor + (hashSeed('best0') % 4), runs: 2 + (hashSeed('runs0') % 5) },
    sea: { lastDay: '', todayFind: '' },
    recent: []
  };
}

/**
 * 把生活状态推进到 now 这一天。
 *
 * 返回 { state, events, changed }：
 *   · events 是**这期间**发生的事（可能跨了好几天，也可能当天已推进过所以为空）；
 *   · changed=false 表示今天已经推进过，什么都没发生——桥接据此决定要不要落盘。
 *
 * 跨多天时会逐天补算，而不是只看今天：隔一周再打开，作物不会一次性全熟在同一天。
 */
export function tickLife(rawState, now = new Date()) {
  const today = dayKey(now);
  let state = rawState && typeof rawState === 'object' && rawState.version ? cloneLife(rawState) : initialLifeState(now);
  if (state.lastTickDay === today) {
    return { state, events: [], changed: false };
  }
  const events = [];
  let cursor = state.lastTickDay || today;
  const gap = Math.max(0, Math.min(60, daysBetween(cursor, today)));
  // 逐天推进；最多补 60 天（再长的空档直接跳到现在，没必要把两个月的事都演一遍）。
  for (let step = 0; step < gap; step++) {
    cursor = addDays(cursor, 1);
    if (!state.farm.plots) state.farm.plots = [];

    // 农场：先收成熟的，再补种
    for (let i = 0; i < state.farm.plots.length; i++) {
      const plot = state.farm.plots[i];
      if (!plot || !plot.crop) {
        const crop = pickBy(CROPS, hashSeed(`${cursor}|fill|${i}`));
        state.farm.plots[i] = { crop: crop.name, plantedDay: cursor, days: crop.days };
        continue;
      }
      if (isRipe(plot, cursor)) {
        state.farm.harvested += 1;
        events.push(`收了 ${plot.crop}（第 ${state.farm.harvested} 次收成）`);
        const crop = pickBy(CROPS, hashSeed(`${cursor}|replant|${i}`));
        state.farm.plots[i] = { crop: crop.name, plantedDay: cursor, days: crop.days };
      }
    }

    // 海：每天一趟
    state.sea.lastDay = cursor;
    state.sea.todayFind = pickBy(SEA_FINDS, hashSeed(`${cursor}|sea`)) || '';

    // 爬塔：每天推进 1~2 层，偶尔翻车重开
    const roll = hashSeed(`${cursor}|tower`) % 100;
    if (roll < 12) {
      // 翻车：回到第一层，但记录最好成绩
      if (state.tower.floor > state.tower.best) state.tower.best = state.tower.floor;
      events.push(`爬塔在第 ${state.tower.floor} 层翻车了，重开一局`);
      state.tower.floor = 1;
      state.tower.runs += 1;
    } else {
      const climb = 1 + (hashSeed(`${cursor}|climb`) % 2);
      state.tower.floor += climb;
      if (state.tower.floor > state.tower.best) state.tower.best = state.tower.floor;
      if (state.tower.floor >= 50) {
        events.push(`爬塔通关了，第 ${state.tower.floor} 层`);
        state.tower.floor = 1;
        state.tower.runs += 1;
      } else if (events.length) {
        events.push(`爬塔到第 ${state.tower.floor} 层`);
      }
    }
  }
  state.lastTickDay = today;
  // 只留最近 5 条事件，防止状态文件无限长
  state.recent = [...(Array.isArray(state.recent) ? state.recent : []), ...events].slice(-5);
  return { state, events, changed: true };
}

function cloneLife(s) {
  return JSON.parse(JSON.stringify(s));
}

function addDays(dayStr, n) {
  const t = Date.parse(`${dayStr}T00:00:00`);
  if (!Number.isFinite(t)) return dayStr;
  const d = new Date(t + n * 86400000);
  return dayKey(d);
}

/** 农场里每一块地现在什么样（给 prompt 用的一句话）。 */
export function farmSummary(state, now = new Date()) {
  const today = dayKey(now);
  const plots = state?.farm?.plots ?? [];
  const grown = [];
  const growing = [];
  for (const p of plots) {
    if (!p || !p.crop) continue;
    const crop = CROPS.find((c) => c.name === p.crop);
    const total = Number(p.days) || (crop ? crop.days : 4);
    const age = daysBetween(p.plantedDay, today);
    if (age >= total) grown.push(p.crop);
    else growing.push({ crop: p.crop, left: total - age });
  }
  if (!grown.length && !growing.length) return '';
  const bits = [];
  if (grown.length) bits.push(`${grown.join('、')}熟了`);
  for (const g of growing.slice(0, 2)) {
    bits.push(`${g.crop}还得${g.left === 0 ? '今天就能收' : `再等${g.left}天`}`);
  }
  return bits.join('，');
}

// ─────────────────────────────────────────────────────────────
// 四、拼成 prompt
// ─────────────────────────────────────────────────────────────

/**
 * 组装注入到唤醒 prompt 里的两段：【你自己的状态】和【你们的关系】。
 *
 * @param {object} opts
 * @param {Date}   opts.now
 * @param {object} opts.lifeState       tickLife 返回的 state
 * @param {number} opts.relationCount   对方发来的累计消息数
 * @param {string} opts.key             会话 key（private:x / group:x）
 * @param {boolean} opts.isOwner        是否是主人私聊
 * @param {string} opts.presence        本会话里对方最近的状态描述（可空）
 * @returns {{ selfLine: string, relationLine: string }}
 */
export function buildInnerLifeLines({ now = new Date(), lifeState = null, relationCount = 0, key = '', isOwner = false } = {}) {
  const state = describeSelfState(now);
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const parts = [`现在 ${weekdayText(now)} ${clock}，你是「${state.label}」的状态。`];
  parts.push(state.voice);

  const lifeBits = [];
  if (lifeState) {
    const farm = farmSummary(lifeState, now);
    if (farm) lifeBits.push(`小农场：${farm}`);
    // 「今天去海里游了一圈」这种话在凌晨说就是穿帮：那个点她还没去。
    // 只有当天已经过了起床时段（08:00 之后）才把她去海里的事算进"今天"。
    const hour = now.getHours();
    if (lifeState.sea?.todayFind && hour >= 8) lifeBits.push(`今天去海里游了一圈，${lifeState.sea.todayFind}`);
    if (lifeState.tower?.floor) {
      // 翻车重开后 floor 会回 1，而 best 可能很高。直接写「打到第 1 层（最好成绩 17）」
      // 读着像数据错了，说成「重开了一局，现在第 1 层」才像真在玩。
      const floor = Number(lifeState.tower.floor) || 1;
      const best = Number(lifeState.tower.best) || floor;
      lifeBits.push(floor <= 1 && best > 3
        ? `爬塔今天翻车重开了，现在第 1 层（最好成绩 ${best}）`
        : `爬塔打到第 ${floor} 层（最好成绩 ${best}）`);
    }
  }
  if (lifeBits.length) {
    parts.push(`你这边：${lifeBits.join('；')}。`);
    parts.push('（这些是你自己的事。被问到"你在干嘛"可以说，想主动分享时也可以说一句；但不用每轮汇报，更不要主动解释你为什么有这些生活。）');
  }
  const selfLine = `【你自己的状态】${parts.join('\n')}\n\n`;

  const tier = relationTier(relationCount);
  const countText = relationCount >= 30 ? `（累计聊了 ${relationCount} 条左右）` : '';
  const relationLine = `【你们的关系：${tier.name}${countText}】${tier.stance}\n\n`;
  return { selfLine, relationLine };
}

/** 主动开口的意愿系数：睡着了就别硬撑，晚上精神好就多接话。 */
export function proactiveFactor(now = new Date()) {
  const s = describeSelfState(now);
  return Math.max(0, Math.min(1, Number(s.proactive) || 0));
}

export const __internals = { DAY_PHASES, RELATION_TIERS, CROPS, SEA_FINDS, GAME_EVENTS, hashSeed };
