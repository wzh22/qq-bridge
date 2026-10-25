import assert from 'node:assert/strict';
import http from 'node:http';
import {test} from 'node:test';
import {requestGptSovits,waveDuration} from '../src/gpt-sovits.js';
import {encodeWave} from '../src/voice-synthesis.js';
const wave=encodeWave(new Int16Array(22050).fill(1000));
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
    assert.equal(JSON.parse(body).text,'你好');assert.equal(JSON.parse(body).ref_audio_path,'reference.wav');
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
