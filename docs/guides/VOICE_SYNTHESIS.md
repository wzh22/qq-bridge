# 本地语音合成

在 reserved2 模式启用 socialV2.voice.enabled、socialV2.tools.sendVoice 和 socialV2.voice.synthesis.enabled，然后重启桥接和 DeepSeek Harness，刷新 MCP 工具参数。

链路只剩一条：

```
文字 → GPT-SoVITS → wav → 发送
```

2026-11-02 起 RVC 变声整体移除（`src/rvc.js`、`scripts/test-rvc.mjs`、`start-rvc.bat` 已删）。原因：RVC 是「音频→音频」，只换音色、不重新合成，接在 TTS 后面等于在最好听的一环上又做一次有损转换；它还要常驻一个独立服务（5050）占着显存，挤掉 TTS 的预算；而且它改不了旋律，唱歌那条路本来也救不回来。现在音色只由参考音频 + 采样参数决定。

## 能做什么

- 说话：`qq_send_voice({key,token,text:"你好，今天也要开心"})`，走 GPT-SoVITS，用配置里的参考音频音色。
- 已有录音：`qq_list_voices` 列库，再 `qq_send_voice({key,token,voice:返回的name})`。文件放在配置的 audio 目录内；支持 mp3、wav 等格式，不下载付费歌曲，也没有全网点歌搜索。

## 采样参数

`socialV2.voice.synthesis` 里这些键决定「同一句话合成出来是什么样」。2026-11-02 把原来写死的采样参数改成了可配置，归一化入口是 `src/gpt-sovits.js` 的 `sovitsTuning()`：越界值会夹到合法区间，非法值回落到默认，绝不把脏参数发给服务端。

| 参数 | 旧值 | 新值 | 合法区间 | 为什么 |
| --- | --- | --- | --- | --- |
| `seed` | `42`（写死） | `-1`（随机） | 安全整数；其余回落 `-1` | 写死种子会让某次难听的采样永久重现，永远不会自愈 |
| `temperature` | 未传（吃服务端默认 `1`） | `0.7` | 0.05–2 | 收紧采样，减少音质抖动 |
| `topK` | 未传（服务端默认 `15`） | `15` | 1–100（取整） | 保持 |
| `topP` | 未传（服务端默认 `1`） | `0.9` | 0.05–1 | 截断长尾，减少破音 |
| `repetitionPenalty` | 未传（服务端默认 `1.35`） | `1.35` | 1–2 | 保持 |
| `textSplitMethod` | `cut5` | `cut2` | `cut0`–`cut5`，非法回落 `cut2` | 见下 |

`seed` 的 `-1` 是 GPT-SoVITS 约定的「随机种子」；只有显式填了安全整数才会锁定。

`speedFactor`（语速，配置里当前是 `1`，区间 0.5–2）也在同一批可配置键里；`enabled`、`provider`、`url`、`refAudioPath`、`promptText` 保持原样。

### textSplitMethod 怎么选

合法取值只有 `cut0`–`cut5`：

| 值 | 含义 |
| --- | --- |
| `cut0` | 不切 |
| `cut1` | 凑四句一切 |
| `cut2` | 凑 50 字一切 |
| `cut3` | 按中文句号切 |
| `cut4` | 按英文句号切 |
| `cut5` | 按标点符号切 |

为什么从 `cut5` 改到 `cut2`：`cut5` 在每个标点处都切一刀，聊天的短句会被切成一个个碎块各自合成，块与块之间有固定的拼接缝，听感就是一顿一顿的；`cut2`「凑 50 字一切」对短文本直接原样返回，长文本才按约 50 字分块，既保住长句的连贯，又避免单块过长。

## 唱歌已停用

`mode=sing`（含 `song=小星星`）现在直接返回「唱歌功能已停用：没有可用的歌声合成引擎」。原因：

2026-10-25 用户反馈「这个唱歌太难听了，删掉 espeak」。原来的短歌是把 eSpeak NG 合成的单字按 MIDI 音高和时间拉伸拼出来的，音色机械，怎么调都不像人唱。同一套 eSpeak 也做过说话的后备音源（`provider` 缺省值），配置一漏写就会静默降级成男声 —— 那次「这个语音好难听」正是它。现在整套 espeak-ng 依赖已移除，说话只认 GPT-SoVITS，配错就明确报错。

RVC 一度是唱歌的备选，2026-11-02 也一并删了：它是变声器，只换音色、不重新合成，改不了旋律。剩下的链路里只有 GPT-SoVITS，它是语音合成（TTS），能按参考音色念文本，但不会按旋律唱。要真正唱歌需要另一套歌声合成（SVC）引擎，目前没有可用引擎 —— 所以宁可明确拒绝，也不硬做再产出一次难听的结果。

将来若接入，入口在 `src/voice-synthesis.js` 的 `normalizeSynthesis`（sing 分支）和 `generateVoice`：把 sing 分支重新打开、接到引擎上即可，其它链路（权限、频率、审计、清理）不用改。

## 安全与限制

配置校验：`requestGptSovits` 只接受本机 http 地址（127.0.0.1 / localhost / [::1]），拒绝重定向、超时、超大响应。返回的 WAV 头部逐字段校验（PCM 16bit、单双声道、采样率 8000–192000、长度自洽），不合规直接报错。

发送沿用会话令牌、目标白名单、静默和频率限制；合成结束再次检查权限，发现途中被关就取消发送。发完或失败都清理生成文件，不留残骸。

验证：`npm run test:voice-synthesis`；`npm run test-voice`；`node scripts/test-audit-bridge.mjs`。集成测试使用隔离的临时配置和模拟 QQ 网关，不向真实 QQ 发送消息。