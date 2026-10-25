// Operator-configured local TTS service. QQ tool inputs never control URLs or reference paths.
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
  url.pathname='/tts';
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  let response;
  try {
    response=await fetch(url,{method:'POST',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({text,text_lang:'zh',ref_audio_path:config.refAudioPath,prompt_text:config.promptText,prompt_lang:'zh',text_split_method:'cut5',batch_size:1,speed_factor:1,media_type:'wav',streaming_mode:false,seed:42})});
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
