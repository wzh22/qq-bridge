import { runtimeDir } from '../scripts/corpus-paths.mjs';
﻿import { readFileSync, existsSync } from "node:fs";
const D = runtimeDir();
const dm=[];
for (let i=1;i<=10;i++){const p=`${D}/bili-batch${i}.json`;if(!existsSync(p))continue;const d=JSON.parse(readFileSync(p,"utf8"));for(const v of d)for(const t of v.danmaku||[])dm.push(String(t));}
const p2=`${D}/bili-dm-1.json`; if(existsSync(p2)){const d=JSON.parse(readFileSync(p2,"utf8"));for(const v of d)for(const t of v.danmaku||[])dm.push(String(t));}
const U=[...new Set(dm)].filter(s=>s&&s.trim());
// 特征弹幕：书名号梗、数字梗、语气词、叠字
const patterns = {
  "书名号造梗": U.filter(s=>/《.+?》/.test(s)).slice(0,60),
  "空降/打卡/考古": U.filter(s=>/空降|打卡|考古|课代表|前排|留名|签到/.test(s)).slice(0,40),
  "前方高能系列": U.filter(s=>/前方高能|高能预警|护体|弹幕护体|血条/.test(s)).slice(0,25),
  "叠字/语气": U.filter(s=>/啊啊啊|哈哈哈|呜呜|嘿嘿|啧啧|好好好|对对对|是是是/.test(s)).slice(0,40),
  "破防/泪目": U.filter(s=>/破防|泪目|哭了|绷不住|难绷|心疼/.test(s)).slice(0,40),
  "6/草/典/乐": U.filter(s=>/^(6+|草+|典|乐|绝|牛|赢|输|乐死|笑死)[！!。～~]*$/.test(s)).slice(0,40),
};
for (const [k,v] of Object.entries(patterns)) { console.log(`\n--- ${k} (${v.length}) ---`); console.log(v.join(" / ")); }
