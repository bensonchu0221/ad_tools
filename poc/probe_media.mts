// 批次驗證常駐媒體清單（media.ts MEDIA）是否出 popin 廣告；URL 失效換新文章後用這支重驗
// 用法：npx tsx poc/probe_media.mts
import { MEDIA } from '../src/tools/adpreview/media.js';
import { probePopin } from '../src/tools/adpreview/shoot.js';

for (const m of MEDIA) {
  const device = m.device ?? 'desktop';
  const r = await probePopin(m.url, device);
  console.log(
    `${m.id}\t${device}\tcards=${r.cardCount}\tads=${r.adCount}\t${r.ms}ms${r.error ? `\tERROR: ${r.error}` : ''}`
  );
}
process.exit(0);
