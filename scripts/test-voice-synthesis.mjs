import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { generateVoice, normalizeSynthesis, encodeWave } from '../src/voice-synthesis.js';
import { inspectAudio, cleanupTemp } from '../src/voice-core.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

// espeak 已删除（2026-10-25）：说话只有 GPT-SoVITS 一条路，唱歌暂时拒绝。
// 这里起一个本地假 SoVITS 服务，验证「配置 → 请求 → 校验 WAV → 落盘」整条链路。
const RATE = 16000;

function fakeSovits({ status = 200, body } = {}) {
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    if (status !== 200) { res.writeHead(status); res.end('nope'); return; }
    const wave = body ?? encodeWave(new Int16Array(RATE).fill(1000), RATE);
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wave.length });
    res.end(wave);
  });
  return server;
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', r));
const close = (server) => { server.closeAllConnections(); return new Promise((r) => server.close(r)); };

test('speech goes through GPT-SoVITS and produces valid WAV', async () => {
  const server = fakeSovits(); await listen(server);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-synthesis-'));
  try {
    const result = await generateVoice(
      { text: '你好，今天也要开心。' },
      { dir, synthesis: { provider: 'gpt-sovits', url: `http://127.0.0.1:${server.address().port}`, refAudioPath: 'ref.wav', promptText: '参考文字' } }
    );
    assert.ok(fs.existsSync(result.file));
    assert.equal(result.mode, 'speech');
    const info = await inspectAudio(result.file, { ffprobePath: 'unavailable-test-only', maxSeconds: 90 });
    assert.equal(info.ok, true); assert.equal(info.codec, 'pcm_s16le');
  } finally { await close(server); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('espeak is gone: wrong provider and any singing are refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-synthesis-'));
  try {
    // provider 写错不再静默降级成男声，直接报错。
    await assert.rejects(
      generateVoice({ text: '你好' }, { dir, synthesis: { provider: 'espeak' } }),
      /只支持 gpt-sovits/
    );
    // 唱歌整条路径关闭，等待 RVC。
    await assert.rejects(generateVoice({ mode: 'sing', song: '小星星' }, { dir }), /已停用/);
    await assert.rejects(generateVoice({ mode: 'sing', text: '一二三四' }, { dir }), /已停用/);
    assert.equal(fs.readdirSync(dir).length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('invalid or excessive requests fail before work', () => {
  for (const body of [{ text: '' }, { text: '好'.repeat(401) }, { mode: 'other', text: '好' }, { mode: 'sing', song: '小星星' }]) {
    assert.throws(() => normalizeSynthesis(body));
  }
});

test('SoVITS service errors surface instead of falling back', async () => {
  const server = fakeSovits({ status: 500 }); await listen(server);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-synthesis-'));
  try {
    await assert.rejects(
      generateVoice({ text: '你好' }, { dir, synthesis: { provider: 'gpt-sovits', url: `http://127.0.0.1:${server.address().port}`, refAudioPath: 'ref.wav', promptText: '参考文字' } }),
      /GPT-SoVITS 服务错误/
    );
    assert.equal(fs.readdirSync(dir).length, 0);
  } finally { await close(server); fs.rmSync(dir, { recursive: true, force: true }); }
});

async function fixture(run, { generate } = {}) {
  const config = { socialV2: { voice: { enabled: true, synthesis: { enabled: true }, maxPerMinute: 2, maxPerHour: 10 }, tools: { sendVoice: true } } };
  const h = await bridgeHarness({ config, globals: { cleanupTemp, ...(generate ? { generateVoice: generate } : {}) } });
  h.setMode('reserved2'); await h.ensureSession('private:123');
  const token = h.getSocialV2State('private:123').agentToken;
  const server = h.startConsoleServer(); if (!server.listening) await new Promise((r) => server.once('listening', r));
  const call = async (body, auth = token) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/send-voice`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-token': auth }, body: JSON.stringify({ key: 'private:123', ...body }) });
    return { status: r.status, body: await r.json() };
  };
  try { await run(h, call); } finally { await new Promise((r) => server.close(r)); await h.close(); }
}

test('real synthesis uses record message, verifies delivery and removes generated file', async () => fixture(async (h, call) => {
  const result = await call({ text: '语音测试', verify: true });
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.body.verified, true);
  assert.equal(result.body.generated, 'speech');
  const sent = h.calls.http.find((c) => c.url.endsWith('/send_private_msg'));
  assert.equal(sent.body.user_id, 123); assert.equal(sent.body.message[0].type, 'record');
  assert.equal(fs.existsSync(sent.body.message[0].data.file), false);
}, { generate: async (_input, { dir }) => {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'test-generated.wav');
  fs.writeFileSync(file, encodeWave(new Int16Array(22050).fill(1000)));
  return { file, name: path.basename(file), mode: 'speech' };
} }));

test('disabled synthesis, missing token and mixed input cannot send', async () => fixture(async (h, call) => {
  assert.equal((await call({ text: '你好' }, '')).status, 403);
  assert.equal((await call({ text: '你好', voice: 'existing.wav' })).status, 400);
  h.cfg.socialV2.voice.synthesis.enabled = false;
  assert.equal((await call({ text: '你好' })).status, 403);
  assert.equal(h.calls.http.filter((c) => c.url.endsWith('/send_private_msg')).length, 0);
}, { generate: async (_input, { dir }) => {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'test-generated.wav');
  fs.writeFileSync(file, encodeWave(new Int16Array(22050).fill(1000)));
  return { file, name: path.basename(file), mode: 'speech' };
} }));

test('singing is refused at the API before any synthesis', async () => fixture(async (h, call) => {
  const song = await call({ mode: 'sing', song: '小星星' });
  assert.equal(song.status, 400);
  assert.match(song.body.error, /已停用/);
  assert.equal(h.calls.http.filter((c) => c.url.endsWith('/send_private_msg')).length, 0);
}));

test('disabling voice while generation is pending cancels send and cleans output', async () => {
  let release, started;
  const waiting = new Promise((r) => { started = r; });
  await fixture(async (h, call) => {
    const pending = call({ text: '你好' }); await waiting;
    assert.equal((await call({ text: '第二条' })).status, 409);
    h.cfg.socialV2.voice.enabled = false; release();
    assert.equal((await pending).status, 400);
    assert.equal(h.calls.http.filter((c) => c.url.endsWith('/send_private_msg')).length, 0);
    assert.equal(fs.readdirSync(path.join(h.temp, 'audio')).length, 0);
  }, { generate: async (_input, { dir }) => {
    fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, 'test-generated.wav');
    fs.writeFileSync(file, encodeWave(new Int16Array(22050).fill(1000)));
    started(); await new Promise((r) => { release = r; }); return { file, name: path.basename(file), mode: 'speech' };
  } });
});
