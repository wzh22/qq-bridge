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
export function sovitsTuning(synthesis = {}) {
  // 空值（null / undefined / 空串）一律当作「没配」，回落默认值。
  // 不这样分的话 `Number(null)` 是 0，会被当成显式给了 0 而夹到下界，
  // 于是「配置里留空」反而变成一个极端的采样参数。
  const missing = (v) => v === null || v === undefined || v === '';
  const num = (value, fallback, { min, max } = {}) => {
    if (missing(value)) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    if (min !== undefined && n < min) return min;
    if (max !== undefined && n > max) return max;
    return n;
  };
  const method = String(synthesis.textSplitMethod ?? '').trim();
  const seedRaw = synthesis.seed;
  const seedNum = Number(seedRaw);
  return {
    temperature: num(synthesis.temperature, 0.7, { min: 0.05, max: 2 }),
    topK: Math.round(num(synthesis.topK, 15, { min: 1, max: 100 })),
    topP: num(synthesis.topP, 0.9, { min: 0.05, max: 1 }),
    repetitionPenalty: num(synthesis.repetitionPenalty, 1.35, { min: 1, max: 2 }),
    speedFactor: num(synthesis.speedFactor, 1, { min: 0.5, max: 2 }),
    // -1 是 GPT-SoVITS 约定的「随机种子」。只有显式填了安全整数才锁定，
    // 其余（缺省、null、小数、字符串）一律回落 -1，避免把脏种子发给服务端。
    seed: missing(seedRaw) || !Number.isSafeInteger(seedNum) ? -1 : Math.trunc(seedNum),
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
    if(!response.ok)throw Error(`GPT-SoVITS 服务错误 (${response.status})`);
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