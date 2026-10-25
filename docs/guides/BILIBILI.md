# B 站能力（只读）

让 QQ 机器人能「看 B 站视频学习」。2026-10-25 实现。

## 一句话结论

**未登录拿不到逐字字幕**（B 站 2022 年后的硬策略）。配了 `SESSDATA` 才有字幕，
但**登录后也不是万事大吉** —— B 站的字幕接口本身有三个坑（间歇性返回空、
AI 字幕会串到别的视频、多P的时长语义不同），代码里都做了防护。

没拿到可靠字幕时，机器人只能看标题/简介/分P大纲/评论/弹幕，
并且会被明确告知「没看到视频内容」，不允许装作看过。

## 为什么要自建，而不是装现成的 npm 包

去 GitHub 调研过，最完整的是 [`Iseenope/bilibili-mcp-server`](https://github.com/Iseenope/bilibili-mcp-server)
（MIT，31 个工具，含字幕/弹幕/评论/直播/扫码登录）。

**没有直接用它**，原因是它的工具面里有一批**真账号上的不可逆写操作**：

| 工具 | 后果 |
|---|---|
| `bilibili_send_danmaku` | 往视频发弹幕（高风控，发多了封号） |
| `bilibili_reply` / `bilibili_delete_comment` / `bilibili_like_comment` | 以主人身份发/删评论、点赞 |
| `bilibili_user_follow` / `unfollow` | 关注/取关（会被风控盯上） |
| `bilibili_login` | 扫码登录 |
| `bilibili_video_download` | 下载 + 调 ffmpeg |

QQ 机器人会在群聊里自主决定「我想学点什么」。如果把上面这些交给它，
等于把一个概率模型的输出接到真实 B 站账号上 —— 发错一条弹幕、误关一个人，
都是不可逆的，而且是以主人的身份。

**所以只取它的「只读玩法」，自己实现**：WBI 签名算法和弹幕 protobuf 字段定义
参考了该仓库（并与 `SocialSisterYi/bilibili-API-collect` 交叉核对），
但工具面砍到只剩 4 个只读工具。依赖（`@modelcontextprotocol/sdk`、`zod`）
本项目已有，**没有新增任何 npm 依赖**。

## 工具

| 工具 | 作用 | 需要登录 |
|---|---|---|
| `bilibili_search` | 搜视频（标题/UP主/播放/时长/BV号） | 否 |
| `bilibili_video_learn` | 抓一个视频的学习材料 | 字幕需要，其余不需要 |
| `bilibili_hot` | 热门榜 | 否 |
| `bilibili_status` | 自检：是否配了 Cookie、接口通不通 | 否 |

`bilibili_video_learn` 返回的内容按**可信度分段**：

- `【字幕·逐字内容】` —— 只有这是视频真正讲了什么
- `【分P大纲】` —— 多P课程的章节标题（100P 的课就是现成学习路径）
- `【章节看点】` —— UP 主标的时间点
- `【高赞评论】` / `【弹幕抽样】` —— **二手信号**，是观众在聊什么，不是视频内容
- `【观众讨论高频词】` —— 粗略印象

## 配置（可选）

想让机器人拿到逐字字幕，在 `config.json` 填：

```json
{
  "socialV2": {
    "bilibili": {
      "sessdata": "你的 SESSDATA"
    }
  }
}
```

或设环境变量 `BILIBILI_SESSDATA`（优先级更高）。

获取方式：浏览器登录 bilibili.com → F12 → Application → Cookies → 复制 `SESSDATA`。

**这个 Cookie 只用于读**：代码里没有任何写接口，`bilibili_status` 可以自查当前状态。
即使 Cookie 泄露，攻击面也只是「能看这个账号能看的视频」，不能发东西。
不想给了随时把 `sessdata` 清空即可，其余能力不受影响。

## 实测数据（2026-10-25）

**未登录**、连测十几个视频（热门/知识区/科普/教程）：

- `subtitle.subtitles` **全部为 `[]`**
- `/x/player/wbi/v2` 返回 `need_login_subtitle: true`
- 弹幕、评论、分P、简介、搜索 **全部正常**

所以「未登录也能看字幕」是不成立的。

**登录后**（`isLogin: true`，实测用户名可正常返回）才发现下面三件更要命的事，
全部已在代码里处理，`scripts/test-bili-subtitle-guard.mjs` 有回归用例守着：

### ① 字幕接口约一半概率返回空

同一视频、同一 Cookie，连打 8 次 `/x/player/v2`，`subtitles` 条数为
`0,0,1,1,1,0,0,1`。所以**「一次没拿到」不能判定没有字幕**，必须重试。
现在 `getSubtitle` 交替打两个接口、最多试 6 次（连空 6 次概率约 1.6%）。

### ② AI 字幕会串到别的视频上（最严重）

同一个 cid 反复请求，返回的是**不同字幕文件**，内容属于**别的视频**：

| 请求的视频 | 实际拿到的字幕首句 |
|---|---|
| 3B1B《线性代数的本质 03》 | 江南水乡种水稻呀 / 大蚂蝗每个人都爱吃 |
| Rick Astley《Never Gonna Give You Up》MV | 我现在是把空吹轮带到另一个院子 |
| Python 100P 教程 | 无法改变现状 |

这类内容比「没有字幕」更糟 —— 它不是噪声，是**看起来像内容的错误事实**，
模型会当真。所以宁可判定失败也不返回可疑字幕。

**判据（实测出的硬规律）**：`ai_subtitle` 的字幕 URL 路径 = `<aid><cid><hash>`，
即**前缀严格等于 aid 拼 cid**。实测 `BV1rpWjevEip`
（aid=113006243481679, cid=36010133667）的正确字幕前缀正是
`11300624348167936010133667`；前缀对不上的全部是串台字幕。

加上时间轴校验（字幕末句时间应落在视频时长的 0.5x~1.6x 内）双重把关。

### ③ 官方字幕可靠，AI 字幕不可靠

`lan=zh-CN / zh-Hans / zh-Hant` 走 `bfs/subtitle/<hash>.json`，实测同一视频
连取 6 次都是 47 行、内容一致（Rick Astley 的中文歌名「永不放弃你——瑞克·艾斯里」）。
`lan=ai-zh` 走 `bfs/ai_subtitle/prod/`，就是上面会串台的那批。
所以选轨顺序是**官方优先，AI 靠后且必须过前缀校验**。

### ④ 多P视频的 duration 是合集总时长

100P 的 Python 教程 `duration=143894s`（39:58:14），但 `cid` 指向的第 1P 只有 `164s`。
拿总时长去校验单P字幕，会把**正确字幕判成错位**。
`getVideoInfo` 现在额外返回 `pageDuration`（当前P时长），校验用它。

### ⑤ 登录凭据在响应头里，不在 body 里

新版 `/x/passport-login/web/qrcode/poll` 登录成功后，**响应体里没有 `cookie_info`**，
凭据只在 `Set-Cookie` 头里（旧版才有 `data.cookie_info.cookies`）。
只读 body 会得到「登录成功但没解析到 SESSDATA」，而此时 ticket 已被消耗，
只能重新扫码。`scripts/bili-login.mjs` 已同时读响应头。

## 踩过的坑

1. **弹幕 protobuf 字段号搞错**
   把 `field 3` 当成 `progress`，结果所有弹幕时间戳都是 `0`，时间轴全错。
   正确：`1 id / 2 progress(ms) / 3 mode / 4 fontsize / 5 color / 6 midHash / 7 content / 8 ctime`。
   现在 `scripts/test-bilibili.mjs` 有回归用例守着。

2. **搜索接口的 `duration` 是 `"12:34"` 字符串**
   直接 `Number()` 会得 `0`，界面上显示 `⏱0s`。要按 `:` 拆分换算。

3. **弹幕噪声**
   实测有整段刷屏的佛号（「南无毗婆尸佛」）、颜文字方块、求资料广告。
   它们本身就是「高频词」，光靠词频过滤不掉，必须显式黑名单 + 字符集白名单
   + 「单条弹幕内同一词只计一次」。

4. **弹幕抽样要按时间排序**
   接口返回顺序里夹杂置顶/热门，直接取前 N 条会全集中在 `00:00`。
   排序后均匀采样才反映整段视频。

5. **`projectRoot()` 用 `process.argv[1]` 推导，换 cwd 就失效**
   表现为「明明写了 sessdata 却报未配置」。改成按 `__dirname` 推导本文件位置
   （node 直跑 / 被 require / 被 DSH spawn 三种情况都成立）。
   `scripts/test-bili-cookie-cwd.mjs` 会用 `C:\`、`C:\Windows`、`%TEMP%`
   三个非仓库根的 cwd 启动 MCP 来验证。

6. **字幕文件没有 `code` 字段**
   `*.hdslb.com/bfs/*subtitle*` 直接返回 `{"body":[...]}`，没有 `code`。
   `biliJson` 原来强制 `code === 0`，于是永远抛 `code=undefined`，
   字幕明明拿到了也报错。现在约定：**`code` 不存在视为成功**，存在且非 0 才抛。

## 扫码登录

```bash
npm run bili-login
```

会打印二维码图片路径（`state/tmp/bili-qr.png`），用 B 站 App 扫，
成功后会写入 `config.json` 的 `socialV2.bilibili`。二维码约 3 分钟过期。

## 相关文件

- `src/bilibili.js` —— 只读 API 客户端（WBI 签名、弹幕 protobuf 解析、字幕归属校验、材料聚合渲染）
- `src/mcp-bilibili-safe.js` —— MCP server，4 个只读工具
- `scripts/bili-login.mjs` —— 扫码登录（会读 `Set-Cookie`）
- `scripts/test-bilibili.mjs` —— 离线单测（含上面几个坑的回归）
- `scripts/test-bili-subtitle-guard.mjs` —— 字幕归属/时长/多P/官方优先 的回归
- `scripts/test-bili-cookie-cwd.mjs` —— 换 cwd 仍能读到 Cookie
- `scripts/setup-dsh.mjs` —— `MANAGED_MCP_IDS` 里注册 `mcp-bilibili-safe`
- `plugins/qq-agent-presets/qq-tool-restrict.mjs` —— `SAFE_PREFIXES` 放行
  `mcp__bilibili-safe__`（只读，理由写在该文件注释里）
- `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` —— 人设里教机器人怎么用、
  以及「没字幕时要如实说没看到」
