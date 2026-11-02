import assert from 'node:assert/strict';
import http from 'node:http';
import {test} from 'node:test';
import {requestGptSovits,waveDuration,sovitsTuning} from '../src/gpt-sovits.js';
import {encodeWave} from '../src/voice-synthesis.js';
const wave=encodeWave(new Int16Array(22050).fill(1000));

test('sovitsTuning 给默认值，并把越界与非法输入收敛到合法区间',()=>{
  // 缺省：seed 必须是 -1（随机）。写死种子是 2026-11-02 之前「难听的音色每次都重现」的原因。
  const d=sovitsTuning({});
  assert.equal(d.temperature,0.7);
  assert.equal(d.topK,15);
  assert.equal(d.topP,0.9);
  assert.equal(d.repetitionPenalty,1.35);
  assert.equal(d.speedFactor,1);
  assert.equal(d.seed,-1);
  assert.equal(d.textSplitMethod,'cut2');

  // 显式值原样保留
  const e=sovitsTuning({temperature:0.2,topK:40,topP:0.5,repetitionPenalty:1.2,speedFactor:1.1,seed:7,textSplitMethod:'cut0'});
  assert.equal(e.temperature,0.2);
  assert.equal(e.topK,40);
  assert.equal(e.topP,0.5);
  assert.equal(e.repetitionPenalty,1.2);
  assert.equal(e.speedFactor,1.1);
  assert.equal(e.seed,7);
  assert.equal(e.textSplitMethod,'cut0');

  // 越界夹紧，而不是原样透传给服务端
  const c=sovitsTuning({temperature:9,topK:999,topP:5,repetitionPenalty:0.1,speedFactor:99});
  assert.equal(c.temperature,2);
  assert.equal(c.topK,100);
  assert.equal(c.topP,1);
  assert.equal(c.repetitionPenalty,1);
  assert.equal(c.speedFactor,2);

  // 非法输入回落默认值
  const bad=sovitsTuning({temperature:'热',topK:'abc',topP:NaN,speedFactor:undefined,seed:'seed',textSplitMethod:'cut9'});
  assert.equal(bad.temperature,0.7);
  assert.equal(bad.topK,15);
  assert.equal(bad.topP,0.9);
  assert.equal(bad.speedFactor,1);
  assert.equal(bad.seed,-1);
  assert.equal(bad.textSplitMethod,'cut2');

  // null / 空串是「没配」，不是「配了 0」——否则 Number(null)=0 会被夹到下界
  const blank=sovitsTuning({temperature:null,topK:null,topP:'',seed:null,textSplitMethod:null});
  assert.equal(blank.temperature,0.7);
  assert.equal(blank.topK,15);
  assert.equal(blank.topP,0.9);
  assert.equal(blank.seed,-1);
  assert.equal(blank.textSplitMethod,'cut2');

  // 纯空白同样算「没配」。曾漏掉这一档：Number('   ')===0 会被当成显式 0，
  // 于是 temperature 被夹到 0.05、seed 变成 0 —— 正是要避免的「留空变极端参数」。
  const ws=sovitsTuning({temperature:'   ',topK:'   ',topP:'   ',speedFactor:'   ',repetitionPenalty:'   ',seed:'   '});
  assert.equal(ws.temperature,0.7);
  assert.equal(ws.topK,15);
  assert.equal(ws.topP,0.9);
  assert.equal(ws.speedFactor,1);
  assert.equal(ws.repetitionPenalty,1.35);
  assert.equal(ws.seed,-1);

  // 整个对象传 null / undefined 不能炸（默认参数只挡 undefined，null 会一路炸到 .textSplitMethod）
  assert.equal(sovitsTuning(null).seed,-1);
  assert.equal(sovitsTuning(undefined).temperature,0.7);

  // 种子区间：GPT-SoVITS 底层只接受 -1 或 [0, 2**32-1]。越界**不会被夹紧，
  // 而是服务端直接 400**（2026-11-02 实测 2**32 / -5 / 2**53-1 均返回
  // "Seed must be between 0 and 2**32 - 1"），所以必须自己拦下并回落 -1，
  // 否则「配置里填了个负数」等于整条语音发不出去。
  for(const badSeed of [-5,-2,4294967296,2**33,2**53-1,3.5]){
    assert.equal(sovitsTuning({seed:badSeed}).seed,-1,`seed=${badSeed} 应回落 -1`);
  }
  assert.equal(sovitsTuning({seed:-1}).seed,-1);                   // 显式随机
  assert.equal(sovitsTuning({seed:0}).seed,0);                     // 下边界合法
  assert.equal(sovitsTuning({seed:4294967295}).seed,4294967295);   // 上边界合法
  assert.equal(sovitsTuning({seed:'42'}).seed,42);                 // 非空数字串可用
  for(const junk of [[],[7],true,{},'abc']){
    assert.equal(sovitsTuning({seed:junk}).seed,-1,`seed=${JSON.stringify(junk)} 不是候选`);
  }
});

test('local API request, output limits, malformed WAV, timeout and redirect rejection',async()=>{
  let mode='ok',body;
  const server=http.createServer(async(req,res)=>{
    body='';for await(const c of req)body+=c;
    if(mode==='timeout')return;
    if(mode==='redirect'){res.writeHead(302,{Location:'http://127.0.0.1:1'});res.end();return;}
    if(mode==='error'){res.writeHead(500);res.end('internal path');return;}
    res.end(mode==='bad'?Buffer.from('not wav'):wave);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const config={url:`http://127.0.0.1:${server.address().port}`,refAudioPath:'reference.wav',promptText:'参考文字'};
  const options={maxBytes:100000,maxSeconds:5,timeoutMs:1000};
  try{
    const result=await requestGptSovits('你好',config,options);
    assert.equal(result.duration,1);assert.deepEqual(result.data,wave);
    const sent=JSON.parse(body);
    assert.equal(sent.text,'你好');assert.equal(sent.ref_audio_path,'reference.wav');
    // 参数层必须真的落到请求体里：只改 sovitsTuning 而忘了接线，键就还是会缺失。
    assert.equal(sent.seed,-1);
    assert.equal(sent.temperature,0.7);
    assert.equal(sent.top_k,15);
    assert.equal(sent.top_p,0.9);
    assert.equal(sent.repetition_penalty,1.35);
    assert.equal(sent.speed_factor,1);
    assert.equal(sent.text_split_method,'cut2');

    // 显式配置要能覆盖默认值并同样落到请求体
    await requestGptSovits('你好',{...config,seed:3,temperature:0.15,topK:2,topP:0.4,textSplitMethod:'cut0'},options);
    const sent2=JSON.parse(body);
    assert.equal(sent2.seed,3);
    assert.equal(sent2.temperature,0.15);
    assert.equal(sent2.top_k,2);
    assert.equal(sent2.top_p,0.4);
    assert.equal(sent2.text_split_method,'cut0');

    // 同一个 config 连发两次，种字段都应原样是 -1，由服务端决定随机 ——
    // 而不是被我们钉成某个固定数字。
    // ⚠️ 不要写成 notEqual(sent.seed,sent2.seed)：那是拿 -1 和 3 比字段值，恒真、什么都没测。
    // 「两次产出真的不同」必须在真实 TTS 上比对字节，假服务覆盖不了。
    // 2026-11-02 手工实测：旧参数(seed=42+cut5) 两次字节完全相同(160044B×2)，
    // 新参数(seed=-1+cut2) 两次不同(170284B / 177964B)。
    await requestGptSovits('你好',config,options);
    assert.equal(JSON.parse(body).seed,-1);

    await assert.rejects(requestGptSovits('你好',config,{...options,maxBytes:100}),/大小/);
    await assert.rejects(requestGptSovits('你好',config,{...options,maxSeconds:0.5}),/时长/);
    mode='bad';await assert.rejects(requestGptSovits('你好',config,options),/WAV/);
    // 非 2xx 的 body 必须被读出来带进错误消息：GPT-SoVITS 把真正原因放在 body 里
    //（例如种子越界返回 "Seed must be between 0 and 2**32 - 1"），
    // 只报状态码的话操作者只能去翻服务端控制台才知道哪里配错。
    mode='error';await assert.rejects(requestGptSovits('你好',config,options),
      (e)=>/500/.test(e.message)&&/internal path/.test(e.message));
    mode='redirect';await assert.rejects(requestGptSovits('你好',config,options));
    mode='timeout';await assert.rejects(requestGptSovits('你好',config,{...options,timeoutMs:50}),/超时/);
    await assert.rejects(requestGptSovits('你好',{...config,url:'https://example.com'},options),/本机/);
    assert.throws(()=>waveDuration(wave.subarray(0,100)),/不完整/);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});