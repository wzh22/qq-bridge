// 贴吧批量语料采集（只读）。
// 用法：node collect-tieba.mjs --forums "孙笑川,李毅" --threads 3 --floors 20 --out tieba-1.json
import { collectCorpus, renderCorpusForLearning, corpusStats } from '../../src/tieba.js';
import { runtimeDir } from '../scripts/corpus-paths.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const forums = String(arg('forums', '孙笑川')).split(',').map((s) => s.trim()).filter(Boolean);
const threadsPerForum = Number(arg('threads', '3'));
const floorsPerThread = Number(arg('floors', '20'));
const maxThreads = Number(arg('max', String(threadsPerForum * forums.length)));
const out = arg('out', 'tieba-latest.json');
const DIR = runtimeDir();

const t0 = Date.now();
console.log(`开始采集：${forums.join('、')} | 每吧${threadsPerForum}帖 | 每帖${floorsPerThread}层 | 上限${maxThreads}帖`);

const corpus = await collectCorpus({
  forums,
  threadsPerForum,
  floorsPerThread,
  maxThreads,
  port: 9222,
  onProgress: (p) => {
    if (p.phase === 'forum') console.log(`  → ${p.forum}吧`);
    else if (p.phase === 'thread') console.log(`    [${p.done + 1}/${p.total}] ${String(p.title).slice(0, 34)}`);
  },
});

mkdirSync(DIR, { recursive: true });
writeFileSync(`${DIR}\\${out}`, JSON.stringify(corpus, null, 2), 'utf8');
const text = renderCorpusForLearning(corpus, { maxChars: 60000 });
writeFileSync(`${DIR}\\${out.replace(/\.json$/, '')}.txt`, text, 'utf8');

const st = corpusStats(corpus);
console.log('---');
console.log(`完成：${st.threads} 帖 / ${st.floors} 楼 / ${st.replies} 条楼中楼 / ${st.chars} 字`);
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (corpus.challenge) console.log('⚠️ 触发人机验证，已停止');
if (corpus.errors?.length) console.log('错误：', JSON.stringify(corpus.errors.slice(0, 5)));
