// 语音合成：只走 GPT-SoVITS。
//
// 2026-10-25 用户要求：「这个唱歌太难听了，删掉espeak，我不需要它发语音和唱歌，稍后我会把唱歌换成rvc」。
// espeak-ng 那套（电子男声说话 + 逐字改音高的电子短歌）已整体移除，原因有二：
//   1. 说话音色机械难听，且原来是 provider 缺省值，配置写错就静默降级成男声；
//   2. 唱歌是 eSpeak 音源拼接，无论如何调都不像人，用户决定改用 RVC。
// 现在 speech 只认 GPT-SoVITS，配错就明确报错，不再退化成难听的替代音。
//
// 2026-11-02 用户要求：「删掉rvc，留下 GPT 剩下的按照你的想法来」。
// RVC 那一段（TTS → wav → RVC 变声 → wav）已整体摘除，理由：
//   1. RVC 是「音频→音频」，只换音色、不重新合成，它接在 TTS 后面会把 TTS
//      好不容易做出来的韵律和气息再洗一遍，等于在最好听的一环上做有损转换；
//   2. 它常驻一个独立服务（5050）占着 8GB 显存里的一大块，挤掉 TTS 的预算；
//   3. 它改不了旋律，唱歌这条路径本来也靠它救不回来。
// 所以现在链路是「文字 → GPT-SoVITS → wav → 发送」，音色完全由参考音频 + 采样参数决定。
// 唱歌仍然整体拒绝：没有歌声合成（SVC）引擎，硬做只会再产出一次难听的结果。
import fs from 'node:fs';
import crypto from 'node:crypto';
import { requestGptSovits } from './gpt-sovits.js';
import { safeJoinLibrary } from './voice-core.js';

export function normalizeSynthesis(input = {}) {
  const mode = input.mode ?? (input.song ? 'sing' : 'speech');
  if (!['speech', 'sing'].includes(mode)) throw new Error('mode 必须是 speech 或 sing');
  // 唱歌整条路径保持关闭：没有可用的歌声合成引擎，宁可明确拒绝，也不发出难听的电子短歌。
  if (mode === 'sing') throw new Error('唱歌功能已停用：没有可用的歌声合成引擎');
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
    const { data, duration } = await requestGptSovits(request.text, synthesis, { maxBytes, maxSeconds, timeoutMs });
    if (data.length > maxBytes) throw new Error('生成语音超过文件大小上限');

    fs.mkdirSync(dir, { recursive: true });
    const name = `generated-${crypto.randomUUID()}.wav`;
    const file = safeJoinLibrary(dir, name);
    if (!file) throw new Error('语音输出路径无效');
    fs.writeFileSync(file, data, { flag: 'wx' });
    return { file, name, duration, mode: request.mode };
  } finally { active = false; }
}