// 语音合成：只走 GPT-SoVITS。
//
// 2026-10-25 用户要求：「这个唱歌太难听了，删掉espeak，我不需要它发语音和唱歌，稍后我会把唱歌换成rvc」。
// espeak-ng 那套（电子男声说话 + 逐字改音高的电子短歌）已整体移除，原因有二：
//   1. 说话音色机械难听，且原来是 provider 缺省值，配置写错就静默降级成男声；
//   2. 唱歌是 eSpeak 音源拼接，无论如何调都不像人，用户决定改用 RVC。
// 现在 speech 只认 GPT-SoVITS，配错就明确报错，不再退化成难听的替代音。
// sing 入口保留但直接拒绝，等 RVC 接进来后再实现（见 docs/guides/VOICE_SYNTHESIS.md）。
import fs from 'node:fs';
import crypto from 'node:crypto';
import { requestGptSovits } from './gpt-sovits.js';
import { safeJoinLibrary } from './voice-core.js';
import { rvcConfig, requestRvc } from './rvc.js';

export function normalizeSynthesis(input = {}) {
  const mode = input.mode ?? (input.song ? 'sing' : 'speech');
  if (!['speech', 'sing'].includes(mode)) throw new Error('mode 必须是 speech 或 sing');
  // 唱歌暂时整条路径关闭：espeak 已删，RVC 尚未接入。宁可明确拒绝，也不发出难听的电子短歌。
  if (mode === 'sing') throw new Error('唱歌功能已停用：espeak 音源已移除，等待接入 RVC');
  const text = String(input.text ?? '').trim();
  if (!text || [...text].length > 400) throw new Error('语音文字需要 1–400 字');
  return { mode, text };
}

// 纯 PCM → WAV 封装。测试用它造夹具，不属于合成逻辑。
export function encodeWave(samples, sampleRate = 22050) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]))), 44 + i * 2);
  return b;
}

let active = false;
export async function generateVoice(input, { dir, maxSeconds = 300, maxBytes = 20971520, timeoutMs = 180000, synthesis = {} } = {}) {
  const request = normalizeSynthesis(input);
  if (active) throw new Error('正在生成另一条语音，请稍后重试');
  active = true;
  try {
    const provider = synthesis.provider ?? 'gpt-sovits';
    if (provider !== 'gpt-sovits') throw new Error(`语音合成只支持 gpt-sovits（当前配置：${provider}）`);
    const { data: rawData, duration: rawDuration } = await requestGptSovits(request.text, synthesis, { maxBytes, maxSeconds, timeoutMs });
    if (rawData.length > maxBytes) throw new Error('生成语音超过文件大小上限');

    // RVC 变声：TTS 决定「说什么」，RVC 决定「像谁」。接在 TTS 之后、落盘之前。
    // 失败时回退到未变声的原始音频 —— 说得出话比音色像更重要，
    // 但要在返回值里标注 rvcFallback，便于排查和前端提示。
    let data = rawData;
    let duration = rawDuration;
    let rvcFallback = null;
    const rvc = rvcConfig(synthesis);
    if (rvc.enabled) {
      try {
        const converted = await requestRvc(rawData, rvc, { maxBytes, maxSeconds });
        data = converted.data;
        duration = converted.duration;
      } catch (error) {
        rvcFallback = error?.message ?? String(error);
        console.warn(`[voice] RVC 变声失败，回退原始音色: ${rvcFallback}`);
      }
    }

    fs.mkdirSync(dir, { recursive: true });
    const name = `generated-${crypto.randomUUID()}.wav`;
    const file = safeJoinLibrary(dir, name);
    if (!file) throw new Error('语音输出路径无效');
    fs.writeFileSync(file, data, { flag: 'wx' });
    return { file, name, duration, mode: request.mode, rvc: rvc.enabled && !rvcFallback, rvcFallback };
  } finally { active = false; }
}
