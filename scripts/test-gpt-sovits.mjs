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

  // 小数种子也收敛为 -1，避免把非整数种子发给服务端
  assert.equal(sovitsTuning({seed:1.5}).seed,-1);
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

    // 不同输入的产出必须不再被同一个种子钉死
    assert.notEqual(sent.seed,sent2.seed);

    await assert.rejects(requestGptSovits('你好',config,{...options,maxBytes:100}),/大小/);
    await assert.rejects(requestGptSovits('你好',config,{...options,maxSeconds:0.5}),/时长/);
    mode='bad';await assert.rejects(requestGptSovits('你好',config,options),/WAV/);
    mode='error';await assert.rejects(requestGptSovits('你好',config,options),/500/);
    mode='redirect';await assert.rejects(requestGptSovits('你好',config,options));
    mode='timeout';await assert.rejects(requestGptSovits('你好',config,{...options,timeoutMs:50}),/超时/);
    await assert.rejects(requestGptSovits('你好',{...config,url:'https://example.com'},options),/本机/);
    assert.throws(()=>waveDuration(wave.subarray(0,100)),/不完整/);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});