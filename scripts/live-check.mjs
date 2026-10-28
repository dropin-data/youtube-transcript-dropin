// Live check, run in CI only: does YouTube block this runner, and does the
// fallback return the same shape? Costs about $0.01 on the Apify account.
import { fetchTranscript } from '../index.js';

const video = process.argv[2] || 'https://www.youtube.com/watch?v=1UL8iZJD38U';
const summary = [];

async function attempt(label, config) {
  const started = Date.now();
  try {
    const rows = await fetchTranscript(video, config);
    const first = rows[0] || {};
    summary.push({
      label,
      ok: true,
      rows: rows.length,
      seconds: ((Date.now() - started) / 1000).toFixed(1),
      first_offset: first.offset,
      first_duration: first.duration,
      lang: first.lang,
      sample: String(first.text || '').slice(0, 40),
    });
    return rows;
  } catch (error) {
    summary.push({ label, ok: false, seconds: ((Date.now() - started) / 1000).toFixed(1), error: error.constructor.name });
    return null;
  }
}

const direct = await attempt('direct (fallback: never)', { fallback: 'never' });
const hosted = process.env.APIFY_TOKEN ? await attempt('hosted (fallback: always)', { fallback: 'always' }) : null;
if (process.env.APIFY_TOKEN) await attempt('auto', {});

console.table(summary);
if (direct && hosted && direct.length > 0) {
  const ratio = hosted[0].offset / (direct[0].offset || 1);
  console.log(`hosted/direct first-offset ratio: ${ratio.toFixed(3)} (1.0 means the units match)`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  const lines = ['| attempt | ok | rows | seconds | first offset | first duration | lang | error |', '|---|---|---|---|---|---|---|---|'];
  for (const s of summary) {
    lines.push(`| ${s.label} | ${s.ok} | ${s.rows ?? ''} | ${s.seconds} | ${s.first_offset ?? ''} | ${s.first_duration ?? ''} | ${s.lang ?? ''} | ${s.error ?? ''} |`);
  }
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}
if (process.env.APIFY_TOKEN && !summary.find((s) => s.label === 'auto')?.ok) process.exit(1);
