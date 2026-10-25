import { runtimeDir } from '../scripts/corpus-paths.mjs';
﻿import { readFileSync, existsSync, writeFileSync } from "node:fs";
// 汇总全部语料到一个可读的语料包，供后续人工/模型归纳
const D = runtimeDir();
const out = [];
let n = { tiebaThreads:0, tiebaFloors:0, tiebaReplies:0, biliVideos:0, biliComments:0, biliDanmaku:0, xhs:0 };
for (let i=1;i<=6;i++) {
  const p = `${D}/tieba-batch${i}.json`;
  if (!existsSync(p)) continue;
  const d = JSON.parse(readFileSync(p,"utf8"));
  n.tiebaThreads += d.threads?.length||0;
  for (const t of d.threads||[]) {
    out.push(`【${t.forum}吧】${t.title}`);
    for (const f of t.floors||[]) {
      if (f.content) { out.push(`${f.author}：${f.content}`); n.tiebaFloors++; }
      for (const r of f.replies||[]) { out.push(`  ${r}`); n.tiebaReplies++; }
    }
    out.push("");
  }
}
const bili = [];
for (let i=1;i<=6;i++) {
  const p = `${D}/bili-batch${i}.json`;
  if (!existsSync(p)) continue;
  const d = JSON.parse(readFileSync(p,"utf8"));
  for (const v of d) {
    n.biliVideos++;
    const dm = [...new Set((v.danmaku||[]).filter(x=>x && x.length<60))];
    n.biliDanmaku += dm.length;
    n.biliComments += (v.comments||[]).length;
    bili.push(`### 《${v.title}》`);
    bili.push("【评论】");
    for (const c of v.comments||[]) bili.push(`- ${c.message}`);
    bili.push("【弹幕】");
    bili.push(dm.slice(0,400).join(" / "));
    bili.push("");
  }
}
const xhs = [];
for (let i=1;i<=3;i++) {
  const p = `${D}/xhs-home${i}.json`;
  if (!existsSync(p)) continue;
  const d = JSON.parse(readFileSync(p,"utf8"));
  n.xhs += d.length;
  for (const c of d) xhs.push(`${c.title}【${c.author}】`);
}
writeFileSync(`${D}/all-tieba.txt`, out.join("\n"), "utf8");
writeFileSync(`${D}/all-bili.txt`, bili.join("\n"), "utf8");
writeFileSync(`${D}/all-xhs.txt`, xhs.join("\n"), "utf8");
console.log(JSON.stringify(n, null, 2));
