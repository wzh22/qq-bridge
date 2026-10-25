// RVC 变声：把 GPT-SoVITS 合成的语音二次转换成目标音色。
//
// RVC（Retrieval-based Voice Conversion）是「音频→音频」，输入输出等长，
// 只改音色不改内容。所以它必须接在 TTS 之后，不能替代 TTS。
//
// 调用方式是常驻 HTTP 服务（rvc_python 的 api 子命令），避免每条语音起一次
// Python 进程 —— 冷启动要 3 秒以上，热态 200~500ms，差一个数量级。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// RVC 服务在 loopback 上，和 GPT-SoVITS 同样的安全约束：不允许外部地址。
function assertLoopback(raw) {
  const url = new URL(raw || 'http://127.0.0.1:5050');
  if (url.protocol !== 'http:') throw new Error('RVC 只支持本机 HTTP 地址');
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw new Error('RVC 只允许 loopback 地址');
  if (url.username || url.password || url.search || url.hash) throw new Error('RVC 地址不能带认证或查询参数');
  return url;
}

export function rvcConfig(synthesis = {}) {
  const rvc = synthesis.rvc ?? {};
  return {
    enabled: rvc.enabled === true,
    url: rvc.url || 'http://127.0.0.1:5050',
    model: String(rvc.model ?? '').trim(),
    f0method: rvc.f0method || 'rmvpe',
    f0upKey: Number.isFinite(rvc.f0upKey) ? rvc.f0upKey : 0,
    indexRate: Number.isFinite(rvc.indexRate) ? rvc.indexRate : 0.5,
    filterRadius: Number.isFinite(rvc.filterRadius) ? rvc.filterRadius : 3,
    rmsMixRate: Number.isFinite(rvc.rmsMixRate) ? rvc.rmsMixRate : 0.25,
    protect: Number.isFinite(rvc.protect) ? rvc.protect : 0.33,
    timeoutMs: Number.isFinite(rvc.timeoutMs) ? rvc.timeoutMs : 60000,
  };
}

/**
 * 把一段 wav 送去 RVC 转换。
 * @returns {Promise<{data: Buffer, duration: number}>} 转换后的 wav
 */
export async function requestRvc(inputBuffer, config, { maxBytes, maxSeconds } = {}) {
  const url = assertLoopback(config.url);
  if (!config.model) throw new Error('RVC 尚未指定音色模型');

  url.pathname = '/infer';
  const form = new FormData();
  form.append('file', new Blob([inputBuffer], { type: 'audio/wav' }), 'input.wav');
  form.append('model', config.model);
  form.append('f0method', config.f0method);
  form.append('f0up_key', String(config.f0upKey));
  form.append('index_rate', String(config.indexRate));
  form.append('filter_radius', String(config.filterRadius));
  form.append('rms_mix_rate', String(config.rmsMixRate));
  form.append('protect', String(config.protect));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(url, { method: 'POST', body: form, redirect: 'error', signal: controller.signal });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`RVC 转换失败 (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    const limit = maxBytes ?? 20971520;
    if (Number(response.headers.get('content-length')) > limit) throw new Error('RVC 输出超过文件大小上限');
    const parts = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > limit) throw new Error('RVC 输出超过文件大小上限');
      parts.push(chunk);
    }
    const data = Buffer.concat(parts);
    assertWav(data);
    const duration = wavDuration(data);
    if (duration <= 0) throw new Error('RVC 返回空音频');
    if (maxSeconds && duration > maxSeconds) throw new Error('RVC 输出超过时长上限');
    return { data, duration };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('RVC 转换超时');
    if (error instanceof TypeError) throw new Error('无法连接 RVC 服务，请先启动本地 RVC');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function assertWav(data) {
  if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('RVC 返回的不是有效 WAV');
  }
}

function wavDuration(data) {
  let byteRate = 0;
  let dataSize = 0;
  for (let p = 12; p + 8 <= data.length;) {
    const id = data.toString('ascii', p, p + 4);
    const n = data.readUInt32LE(p + 4);
    const start = p + 8;
    if (start + n > data.length) break;
    if (id === 'fmt ' && n >= 16) byteRate = data.readUInt32LE(start + 8);
    if (id === 'data') dataSize = n;
    p = start + n + (n % 2);
  }
  return byteRate > 0 ? dataSize / byteRate : 0;
}

/** 探测 RVC 服务是否在线，用于发送前的快速判断。 */
export async function rvcHealth(config, { timeoutMs = 3000 } = {}) {
  const url = assertLoopback(config.url);
  url.pathname = '/health';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal, redirect: 'error' });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
