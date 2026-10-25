# 本地语音合成

在 reserved2 模式启用 socialV2.voice.enabled、socialV2.tools.sendVoice 和 socialV2.voice.synthesis.enabled，然后重启桥接和 DeepSeek Harness，刷新 MCP 工具参数。

## 能做什么

- 说话：`qq_send_voice({key,token,text:"你好，今天也要开心"})`，走 GPT-SoVITS，用配置里的参考音频音色。
- 已有录音：`qq_list_voices` 列库，再 `qq_send_voice({key,token,voice:返回的name})`。文件放在配置的 audio 目录内；支持 mp3、wav 等格式，不下载付费歌曲，也没有全网点歌搜索。

## 唱歌已停用

`mode=sing`（含 `song=小星星`）现在直接返回「唱歌功能已停用：espeak 音源已移除，等待接入 RVC」。原因：

2026-10-25 用户反馈「这个唱歌太难听了，删掉 espeak」。原来的短歌是把 eSpeak NG 合成的单字按 MIDI 音高和时间拉伸拼出来的，音色机械，怎么调都不像人唱。同一套 eSpeak 也做过说话的后备音源（`provider` 缺省值），配置一漏写就会静默降级成男声 —— 那次「这个语音好难听」正是它。现在整套 espeak-ng 依赖已移除，说话只认 GPT-SoVITS，配错就明确报错。

后续唱歌换 RVC，接入位置在 `src/voice-synthesis.js` 的 `normalizeSynthesis` 和 `generateVoice`：把 sing 分支重新打开，接 RVC 推理服务即可，其它链路（权限、频率、审计、清理）不用改。

## 安全与限制

配置校验：`requestGptSovits` 只接受本机 http 地址（127.0.0.1 / localhost / [::1]），拒绝重定向、超时、超大响应。返回的 WAV 头部逐字段校验（PCM 16bit、单双声道、采样率 8000–192000、长度自洽），不合规直接报错。

发送沿用会话令牌、目标白名单、静默和频率限制；合成结束再次检查权限，发现途中被关就取消发送。发完或失败都清理生成文件，不留残骸。

验证：`npm run test:voice-synthesis`；`npm run test:voice`；`node scripts/test-audit-bridge.mjs`。集成测试使用隔离的临时配置和模拟 QQ 网关，不向真实 QQ 发送消息。
