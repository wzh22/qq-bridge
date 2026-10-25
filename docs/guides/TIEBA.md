# 百度贴吧能力（只读）

让 QQ 机器人能「看贴吧」：读帖子、看大家在聊什么、学说话方式。2026-10-25 实现。

## 一句话结论

**贴吧没法用普通 HTTP 请求读**——一律返回 403 + 百度人机验证。唯一正当路径是
复用**主人自己**已经通过验证的浏览器会话，通过 Chrome DevTools Protocol 读渲染后的
DOM。所以：**必须有一个开着 `--remote-debugging-port=9222` 的浏览器**，否则工具会
明确报错并告诉你怎么开（不静默失败、不绕路去爬）。

## 工具

| 工具 | 作用 | 耗时 |
|---|---|---|
| `tieba_status` | 自检：CDP 通不通 | 秒级 |
| `tieba_read_forum` | 读某个吧的帖子列表（标题/作者/回复/点赞） | 5~10 秒 |
| `tieba_read_thread` | 读一个帖子的楼层与楼中楼 | 5~10 秒 |
| `tieba_learn_style` | 采样若干吧的语料，返回压缩文本给模型分析 | 30 秒~3 分钟 |

**四个全是只读**。`src/tieba.js` 里不存在发帖/回帖/点赞/关注/收藏的任何实现。

`tieba_learn_style` 只**取语料**，不调模型、不写文件 —— MCP server 里没有模型。
风格怎么提炼、要不要落盘，是机器人自己的事。

## 为什么不用 fetch（实测记录）

2026-10-25 在西安电信（1.85.244.160）实测，全部失败：

| 尝试 | 结果 |
|---|---|
| 普通 `fetch` / `curl` / `Invoke-WebRequest` | 403 + BIOC 验证页 |
| 换 UA、完整浏览器头、移动端 UA | 403 |
| 先访问 baidu.com 拿 BAIDUID cookie 再请求 | 200，但只是 11060 字节空壳页 |
| 走代理 | 403 |
| Edge `--headless=new --dump-dom` | 百度安全验证 |

真实浏览器能正常访问。所以走 CDP —— 那是 Chrome/Edge 的**官方调试接口**，
读的是渲染后的 DOM，**不解析、不伪造、不绕过任何验证**，验证由主人的浏览器正常完成。

## 启动浏览器

```powershell
pwsh -File scripts\start-tieba-browser.ps1
```

默认 9222 端口，数据目录 `state/edge-cdp-profile`（**独立目录，不复用日常 Edge 配置**，
避免把登录态/收藏夹暴露给调试端口）。用完关掉窗口即可。

> ⚠️ 调试端口开着时，本机任何程序都能通过它读取这个浏览器里的页面。所以用独立
> profile 而不是主人日常用的那个。这条已写进脚本注释。

## 踩过的坑

这些都是**实测**出来的，`scripts/test-tieba-parser.mjs` 有 12 条断言守着。

### ① 列表页改版，旧选择器全部失效

贴吧列表页现在是卡片式布局（`.thread-card-wrapper`），
`a.j_th_tit` / `.threadlist_title a` **一个都匹配不到**。

更坑的是 `a.thread-content-link` 的 `innerText` 是**整块卡片文本**：

```
勤恳还倜傥丶好汉0y 核心吧友 回复于6小时前 关注 她是不是觉得自己很卡哇伊，真可笑 7 370 871
└────────── 作者 ──────────┘ └等级┘ └── 回复时间 ──┘ └关注┘ └────────── 真正的标题 ──────────┘ └统计┘
```

早期实现直接拿它当标题，于是标题里混进了作者、等级、关注按钮。
正确位置是 `.thread-title .tb-richtext`。

### ② `summary` 是整页文本的复制品

早期用「往上找父元素、文本变长就是摘要」的启发式，结果每次都撞到最外层容器，
**所有帖子的 summary 都是同一段整页文本**。已删除该字段，改为结构化取
作者（`a.head-name`）和统计（`.action-bar-warp .item-warp`）。

### ③ 楼层号存了整串，渲染时又拼一次

`floor = '第2楼'`，模板里再写 `第${floor}楼` → 输出 **「第第2楼楼」**。
现在只存纯数字。

### ④ `第N楼` 后 `break`，导致日期永远读不到

实测行序是 `[作者, 等级, 正文, 第N楼, 日期, 地区, ...]` —— 楼层号后面紧跟的就是日期。
早期一遇到 `第N楼` 就 `break`，于是**所有楼层的 `date` 都是空串**。
改成「记下楼层号，继续读后续元数据」。

### ⑤ 日期格式含 `MM-DD`

非当年发布的帖子，时间渲染成 `08-20` 而不是 `2026-08-20`。
早期正则不认 `MM-DD`，于是 `08-20` 被当成正文写进 `content`，而 `date` 反过来是空。

### ⑥ 纯图片楼层会把楼中楼作者当正文

纯图楼的 innerText 是 `[作者, 等级, 第4楼, 08-20, 浙江, ...楼中楼作者...]`，
它本身**没有文字正文**。早期兜底逻辑会一路扫到楼中楼的作者名，
把「启蒙大蕃鸭」当成本楼正文。现在：有楼层号或有日期时不兜底，宁可留空。

### ⑦ 楼中楼有独立容器 `.pb-lzl-item`

早期按「时间行」切段猜边界，结果点赞数 `3` 被当成正文，
语料里出现「TYplus0603 铁杆吧友 3」这种脏行。
现在直接查 `.pb-lzl-item` 容器，边界天然正确。

## 语料质量与安全

贴吧语料里有大量地域黑、人身攻击、擦边内容。

- `buildStyleLearningPrompt` 明确要求模型输出 `avoid` 字段（**不该学的**）
- `buildStyleContext` 注入 prompt 时带「是语感参考，不是让你复读」
- 人设里也写死了：可以体会语感，但**不要把攻击性说法学进群里**，
  也不要转述具体的人身攻击内容

## 相关文件

- `src/tieba.js` —— 只读客户端（CDP、DOM 提取、语料渲染、风格档案读写）
- `src/mcp-tieba-safe.js` —— MCP server，4 个只读工具
- `scripts/start-tieba-browser.ps1` —— 启动带调试端口的独立 Edge
- `scripts/test-tieba-parser.mjs` —— 离线回归（上面 ①~⑦ 的断言）
- `scripts/setup-dsh.mjs` —— `MANAGED_MCP_IDS` 注册 `mcp-tieba-safe`（300s 超时）
- `plugins/qq-agent-presets/qq-tool-restrict.mjs` —— `SAFE_PREFIXES` 放行
  `mcp__tieba-safe__`（只读，理由写在文件注释里）
- `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` —— 人设里教怎么用、
  以及「慢工具别乱调」「遇到 403 就让主人开浏览器」

## 未接入的部分

`src/tieba.js` 里的**风格档案持久化**（`loadStyle` / `saveStyle` /
`buildStyleContext`）目前只有实现，**桥接还没调它**。

也就是说：机器人能采集语料、能自己分析风格，但「把分析结果存成档案、
之后自动注入群聊 prompt」这条链路还没接。要接的话，参照 slang 的做法在
`src/bridge.js` 里加载 `state/tieba-style.json` 并注入即可（`buildSlangContext`
的三个调用点就是模板）。
