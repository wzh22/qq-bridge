# 本地中文女声

普通说话可用 GPT-SoVITS v2Pro。短歌已停用（没有歌声合成引擎，RVC 已于 2026-11-02 移除），音频库播放不受影响。GPT-SoVITS 不是歌声合成器，不会按歌名自动演唱流行歌曲。

语音服务只监听 `127.0.0.1:9880`。QQ 工具只能提供文字，服务地址、参考音频路径和参考文字均由管理员配置；服务失败会报错，不会悄悄退回机械音。

`socialV2.voice.synthesis` 配置示例：

```json
{
  "enabled": true,
  "provider": "gpt-sovits",
  "url": "http://127.0.0.1:9880",
  "refAudioPath": "E:/dsh/qq-bridge/tools/gpt-sovits/GPT-SoVITS-v2pro-20250604/reference/zh-female.wav",
  "promptText": "希望你以后能够做的比我还好呦。",
  "temperature": 0.7,
  "topK": 15,
  "topP": 0.9,
  "repetitionPenalty": 1.35,
  "speedFactor": 1,
  "seed": -1,
  "textSplitMethod": "cut2"
}
```

采样参数（`temperature` 起的那 7 个键）的含义、合法区间与调法见 [VOICE_SYNTHESIS.md](./VOICE_SYNTHESIS.md#采样参数)。其中 `seed` 只接受 `-1`（随机）或 0–4294967295 的整数，越界会让服务端直接报错，所以本层会拦下并回落 `-1`。

参考音频来自 CosyVoice 公开零样本演示，来源保存在引擎 `reference/provenance.json`。这是合成音色，未承诺真人身份或专业歌手效果。文本上限 400 字；实际语音仍受桥接的时长、大小、频率、白名单和发送前权限复核限制。

修改 JS 源文件需要重启桥接；修改 MCP 描述和预设后需要重启 DSH 才能让已运行的工具进程读取新版。不能仅凭新启动的测试进程认为现有 DSH 已更新。

测试：`node --test scripts/test-gpt-sovits.mjs scripts/test-voice-synthesis.mjs`。
