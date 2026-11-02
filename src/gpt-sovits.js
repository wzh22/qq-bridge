// Operator-configured local TTS service. QQ tool inputs never control URLs or reference paths.

/**
 * GPT-SoVITS 支持的文本切分方法。
 *
 * 这里的默认值从 cut5 换成 cut2，是 2026-11-02 针对「听着不自然」的调整：
 * cut5 在每个标点处都切一刀，聊天的短句会被切成一个个碎块各自合成，
 * 块与块之间有固定的拼接缝，听感就是一顿一顿的。cut2「凑 50 字一切」
 * 对短文本直接原样返回（`len(inps) < 2` 时不分段），长文本才按约 50 字分块，
 * 既保留了长句的连贯，又避免单块过长。
 */
const SPLIT_METHODS = new Set(['cut0', 'cut1', 'cut2', 'cut3', 'cut4', 'cut5']);

/**
 * 采样参数归一化。
 *
 * 之前这些参数全部写死在请求体里（`seed: 42`、`text_split_method: 'cut5'`，
 * temperature/top_k/top_p 一个都没传、吃服务端默认值），导致两个问题：
 *   1. `seed: 42` 让每条文本的产出完全可复现 —— 一旦某次采样落在难听的位置，
 *      那难听的音色就每次都重现，永远不会自愈；
 *   2. temperature=1 / top_p=1（服务端默认）采样范围过宽，音质在多次合成之间抖动明显。
 *
 * 现在统一走这里：默认 seed=-1（随机，让音色在自然范围内浮动）、
 * temperature=0.7 / top_p=0.9（收紧采样，减少破音与忽高忽低）。
 * 越界值会被夹到合法区间，非法值回落到默认，绝不把脏参数发给服务端。
 */
// GPT-SoVITS 的种子取值受底层 torch/numpy 限制：只接受 [0, 2**32-1] 的整数，
// 其中 -1 是约定的「随机」。越界**不是被夹紧，而是服务端直接 400**
// （实测 seed=2**32、-5、2**53-1 都返回 "Seed must be between 0 and 2**32 - 1"），
// 所以这里必须自己拦住：不合法一律回落 -1（随机），绝不把脏种子发出去。
const SEED_MAX = 4294967295;
/** 只把「数值」和「非空数字串」当作候选；数组/布尔/对象/空白一律不是。 */
const isSeedCandidate = (v) => typeof v === 'number'
  || (typeof v === 'string' && v.trim() !== '');

function seedOf(raw) {
  if (!isSeedCandidate(raw)) return -1;   // 缺省 / 空白 / 数组 / 布尔 / 对象
  const n = Number(raw);
  if (!Number.isInteger(n)) return -1;    // 小数、NaN、Infinity
  if (n === -1) return -1;                // 显式声明随机
  if (n < 0 || n > SEED_MAX) return -1;   // 服务端硬约束：越界不发，回落随机
  return n;
}

export function sovitsTuning(synthesis) {
  // 默认参数只对 undefined 生效，null 会一路炸到 .textSplitMethod（见复查发现）。
  const s = synthesis && typeof synthesis === 'object' ? synthesis : {};
  // 空值一律当作「没配」，回落默认值。除 null/undefined 外，**纯空白字符串**也算没配：
  // `Number('   ')` 是 0，会被当成显式给了 0 而夹到下界，
  // 于是「配置里留空」反而变成一个极端的采样参数。
  const missing = (v) => v === null || v === undefined
    || (typeof v === 'string' && v.trim() === '');
  const num = (value, fallback, { min, max } = {}) => {
    if (missing(value)) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    if (min !== undefined && n < min) return min;
    if (max !== undefined && n > max) return max;
    return n;
  };
  const method = String(s.textSplitMethod ?? '').trim();
  return {
    temperature: num(s.temperature, 0.7, { min: 0.05, max: 2 }),
    topK: Math.round(num(s.topK, 15, { min: 1, max: 100 })),
    topP: num(s.topP, 0.9, { min: 0.05, max: 1 }),
    repetitionPenalty: num(s.repetitionPenalty, 1.35, { min: 1, max: 2 }),
    speedFactor: num(s.speedFactor, 1, { min: 0.5, max: 2 }),
    seed: seedOf(s.seed),
    textSplitMethod: SPLIT_METHODS.has(method) ? method : 'cut2',
  };
}

export function waveDuration(data) {
  if(data.length<44 || data.toString('ascii',0,4)!=='RIFF' || data.toString('ascii',8,12)!=='WAVE') throw Error('语音服务未返回有效 WAV');
  let format, size;
  for(let p=12;p+8<=data.length;){
    const id=data.toString('ascii',p,p+4),n=data.readUInt32LE(p+4),start=p+8;
    if(start+n>data.length)throw Error('语音 WAV 数据不完整');
    if(id==='fmt ' && n>=16)format={codec:data.readUInt16LE(start),channels:data.readUInt16LE(start+2),rate:data.readUInt32LE(start+4),bytes:data.readUInt32LE(start+8),align:data.readUInt16LE(start+12),bits:data.readUInt16LE(start+14)};
    if(id==='data')size=n;
    p=start+n+(n%2);
  }
  if(!format || format.codec!==1 || ![1,2].includes(format.channels) || format.bits!==16 || format.rate<8000 || format.rate>192000 || format.align!==format.channels*2 || format.bytes!==format.rate*format.align || !size || size%format.align)throw Error('语音服务返回了不支持的 PCM 格式');
  return size/format.bytes;
}

export async function requestGptSovits(text, config, {maxBytes,maxSeconds,timeoutMs}) {
  const url=new URL(config.url || 'http://127.0.0.1:9880');
  if(url.protocol!=='http:' || !['127.0.0.1','[::1]','localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash)throw Error('GPT-SoVITS 需要本机 HTTP 地址');
  if(!config.refAudioPath || !config.promptText)throw Error('GPT-SoVITS 尚未配置参考音频和对应文字');
  const tuning=sovitsTuning(config);
  url.pathname='/tts';
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  let response;
  try {
    response=await fetch(url,{method:'POST',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({text,text_lang:'zh',ref_audio_path:config.refAudioPath,prompt_text:config.promptText,prompt_lang:'zh',text_split_method:tuning.textSplitMethod,batch_size:1,speed_factor:tuning.speedFactor,media_type:'wav',streaming_mode:false,seed:tuning.seed,temperature:tuning.temperature,top_k:tuning.topK,top_p:tuning.topP,repetition_penalty:tuning.repetitionPenalty})});
    if(!response.ok){
      // 必须读 body 再抛：GPT-SoVITS 把真正的原因放在 body 里
      // （例如种子越界会返回 "Seed must be between 0 and 2**32 - 1"），
      // 只报状态码的话操作者只能去翻服务端控制台才知道哪里配错了。
      let detail='';
      try{ detail=(await response.text()).replace(/\s+/g,' ').trim().slice(0,200); }catch{}
      throw Error(`GPT-SoVITS 服务错误 (${response.status})${detail?`：${detail}`:''}`);
    }
    if(Number(response.headers.get('content-length'))>maxBytes)throw Error('生成语音超过文件大小上限');
    const parts=[];let bytes=0;
    for await(const chunk of response.body){bytes+=chunk.length;if(bytes>maxBytes)throw Error('生成语音超过文件大小上限');parts.push(chunk);}
    const data=Buffer.concat(parts),duration=waveDuration(data);
    if(duration<=0 || duration>maxSeconds)throw Error('生成语音为空或超过时长上限');
    return {data,duration};
  } catch(error) {
    if(controller.signal.aborted)throw Error('GPT-SoVITS 合成超时，请稍后重试');
    if(error instanceof TypeError)throw Error('无法连接 GPT-SoVITS，请先启动本地语音服务');
    throw error;
  } finally {controller.abort();clearTimeout(timer);}
}