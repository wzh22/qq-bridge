import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { rvcConfig, requestRvc, rvcHealth } from '../src/rvc.js';
import { generateVoice, encodeWave } from '../src/voice-synthesis.js';

// RVC 是「音频→音频」：TTS 决定说什么，RVC 决定像谁。
// 这里起假服务验证：请求格式、WAV 校验、超时/错误处理、以及失败时回退到未变声音频。

const RATE = 16000;

function fakeServer(handler) {
  const server = http.createServer(handler);
  return server;
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', r));
const close = (server) => { server.closeAllConnections(); return new Promise((r) => server.close(r)); };

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

test('rvcConfig applies defaults and keeps explicit values', () => {
  const d = rvcConfig({});
  assert.equal(d.enabled, false);           // 默认关闭，不改变既有行为
  assert.equal(d.url, 'http://127.0.0.1:5050');
  assert.equal(d.f0method, 'rmvpe');
  assert.equal(d.f0upKey, 0);
  assert.equal(d.indexRate, 0.5);

  const e = rvcConfig({ rvc: { enabled: true, url: 'http://127.0.0.1:6000', model: 'rem-genai', f0upKey: -2, indexRate: 0.7 } });
  assert.equal(e.enabled, true);
  assert.equal(e.url, 'http://127.0.0.1:6000');
  assert.equal(e.model, 'rem-genai');
  assert.equal(e.f0upKey, -2);
  assert.equal(e.indexRate, 0.7);
  assert.equal(e.protect, 0.33);            // 未指定的仍用默认
});

test('requestRvc refuses non-loopback hosts', async () => {
  const cfg = rvcConfig({ rvc: { enabled: true, model: 'x', url: 'http://10.0.0.5:5050' } });
  await assert.rejects(requestRvc(Buffer.alloc(44), cfg), /loopback/);
});

test('requestRvc requires a model', async () => {
  const cfg = rvcConfig({ rvc: { enabled: true } });
  await assert.rejects(requestRvc(Buffer.alloc(44), cfg), /音色模型/);
});

test('requestRvc posts the file and returns the converted wav', async () => {
  const out = encodeWave(new Int16Array(RATE).fill(800), RATE);
  const server = fakeServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/infer');
    assert.match(req.headers['content-type'] ?? '', /multipart\/form-data/);
    const body = await readBody(req);
    // 表单里必须带上模型名和音高参数
    assert.ok(body.includes(Buffer.from('rem-genai')), '应包含模型名');
    assert.ok(body.includes(Buffer.from('rmvpe')), '应包含 f0method');
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': out.length });
    res.end(out);
  });
  await listen(server);
  try {
    const cfg = rvcConfig({ rvc: { enabled: true, model: 'rem-genai', url: `http://127.0.0.1:${server.address().port}` } });
    const r = await requestRvc(encodeWave(new Int16Array(RATE).fill(500), RATE), cfg);
    assert.equal(r.data.length, out.length);
    assert.ok(r.duration > 0.9 && r.duration < 1.1, `时长应约 1s，实际 ${r.duration}`);
  } finally { await close(server); }
});

test('requestRvc surfaces server errors and non-wav payloads', async () => {
  const bad = fakeServer((req, res) => { res.writeHead(500); res.end('模型不存在'); });
  await listen(bad);
  try {
    const cfg = rvcConfig({ rvc: { enabled: true, model: 'x', url: `http://127.0.0.1:${bad.address().port}` } });
    await assert.rejects(requestRvc(Buffer.alloc(44), cfg), /RVC 转换失败.*500/);
  } finally { await close(bad); }

  const notWav = fakeServer((req, res) => { res.writeHead(200); res.end('这不是 wav'); });
  await listen(notWav);
  try {
    const cfg = rvcConfig({ rvc: { enabled: true, model: 'x', url: `http://127.0.0.1:${notWav.address().port}` } });
    await assert.rejects(requestRvc(Buffer.alloc(44), cfg), /不是有效 WAV/);
  } finally { await close(notWav); }
});

test('requestRvc reports an unreachable service', async () => {
  // 用一个刚关闭的端口，确保连不上。
  const cfg = rvcConfig({ rvc: { enabled: true, model: 'x', url: 'http://127.0.0.1:1' } });
  await assert.rejects(requestRvc(Buffer.alloc(44), cfg), /无法连接 RVC/);
});

test('rvcHealth reports service state without throwing', async () => {
  const server = fakeServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  await listen(server);
  try {
    const up = rvcConfig({ rvc: { enabled: true, url: `http://127.0.0.1:${server.address().port}` } });
    assert.equal(await rvcHealth(up), true);
  } finally { await close(server); }
  const down = rvcConfig({ rvc: { enabled: true, url: 'http://127.0.0.1:1' } });
  assert.equal(await rvcHealth(down), false);
});

test('generateVoice applies RVC when enabled', async () => {
  const ttsOut = encodeWave(new Int16Array(RATE).fill(1000), RATE);
  const rvcOut = encodeWave(new Int16Array(RATE * 2).fill(700), RATE * 2);

  const tts = fakeServer((req, res) => { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(ttsOut); });
  const rvc = fakeServer(async (req, res) => {
    await readBody(req);
    res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(rvcOut);
  });
  await listen(tts); await listen(rvc);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvc-synthesis-'));
  try {
    const r = await generateVoice({ text: '你好' }, {
      dir,
      synthesis: {
        provider: 'gpt-sovits', url: `http://127.0.0.1:${tts.address().port}`,
        refAudioPath: 'ref.wav', promptText: '参考',
        rvc: { enabled: true, model: 'rem-genai', url: `http://127.0.0.1:${rvc.address().port}` },
      },
    });
    assert.equal(r.rvc, true);
    assert.equal(r.rvcFallback, null);
    assert.equal(fs.statSync(r.file).size, rvcOut.length, '落盘的应是变声后的音频');
  } finally { await close(tts); await close(rvc); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('generateVoice falls back to raw TTS audio when RVC is down', async () => {
  const ttsOut = encodeWave(new Int16Array(RATE).fill(1000), RATE);
  const tts = fakeServer((req, res) => { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(ttsOut); });
  await listen(tts);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvc-fallback-'));
  try {
    const r = await generateVoice({ text: '你好' }, {
      dir,
      synthesis: {
        provider: 'gpt-sovits', url: `http://127.0.0.1:${tts.address().port}`,
        refAudioPath: 'ref.wav', promptText: '参考',
        rvc: { enabled: true, model: 'rem-genai', url: 'http://127.0.0.1:1' },
      },
    });
    // 音色失败不能让语音彻底发不出去
    assert.equal(r.rvc, false);
    assert.match(r.rvcFallback, /无法连接 RVC/);
    assert.equal(fs.statSync(r.file).size, ttsOut.length, '落盘的应是原始 TTS 音频');
  } finally { await close(tts); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('generateVoice skips RVC entirely when disabled', async () => {
  const ttsOut = encodeWave(new Int16Array(RATE).fill(1000), RATE);
  const tts = fakeServer((req, res) => { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(ttsOut); });
  await listen(tts);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvc-off-'));
  try {
    const r = await generateVoice({ text: '你好' }, {
      dir,
      synthesis: {
        provider: 'gpt-sovits', url: `http://127.0.0.1:${tts.address().port}`,
        refAudioPath: 'ref.wav', promptText: '参考',
      },
    });
    assert.equal(r.rvc, false);
    assert.equal(r.rvcFallback, null);
    assert.equal(fs.statSync(r.file).size, ttsOut.length);
  } finally { await close(tts); fs.rmSync(dir, { recursive: true, force: true }); }
});
