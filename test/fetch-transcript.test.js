// Offline tests: every network call goes to a stubbed fetch.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  YoutubeTranscript,
  fetchTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptError,
  YoutubeTranscriptNotAvailableLanguageError,
  YoutubeTranscriptVideoUnavailableError,
} from '../index.js';

const ID = 'dQw4w9WgXcQ';
const TRACK_URL = 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en';
const SRV3 =
  '<timedtext format="3"><body><p t="1360" d="1680"><s>We&#39;re</s><s> no strangers</s></p>' +
  '<p t="3040" d="2000">to love &amp; rules</p></body></timedtext>';
const CLASSIC = '<transcript><text start="1.36" dur="1.68">We&amp;#39;re no strangers</text></transcript>';
const ACTOR_OK = [
  {
    video_id: ID,
    language_code: 'en',
    timestamped: [
      { text: "We're no strangers", start: 1.36, duration: 1.68 },
      { text: 'to love & rules', start: 3.04, duration: 2.0 },
    ],
  },
];

const realFetch = globalThis.fetch;
const realToken = process.env.APIFY_TOKEN;
let calls;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function text(body, status = 200) {
  return new Response(body, { status });
}

// routes: { innertube, watch, track, apify } -> function(request body) => Response
function stub(routes) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    let kind;
    if (u.includes('/youtubei/v1/player')) kind = 'innertube';
    else if (u.includes('/watch?v=')) kind = 'watch';
    else if (u.includes('/api/timedtext')) kind = 'track';
    else if (u.includes('api.apify.com')) kind = 'apify';
    calls.push({ kind, url: u, body, headers: init.headers });
    const handler = routes[kind];
    if (!handler) throw new TypeError(`fetch failed: no stub for ${u}`);
    return handler(body);
  };
}

const tracks = (...langs) => ({
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: langs.map((l) => ({ languageCode: l, baseUrl: `${TRACK_URL.replace('lang=en', `lang=${l}`)}` })),
    },
  },
});
const BLOCKED_INNERTUBE = () => json({ playabilityStatus: { status: 'LOGIN_REQUIRED' } });
const BLOCKED_WATCH = () =>
  text('<html><script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"LOGIN_REQUIRED"}};</script></html>');

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realToken === undefined) delete process.env.APIFY_TOKEN;
  else process.env.APIFY_TOKEN = realToken;
});

test('direct InnerTube path parses srv3 in milliseconds, like youtube-transcript', async () => {
  delete process.env.APIFY_TOKEN;
  stub({ innertube: () => json(tracks('en')), track: () => text(SRV3) });
  const out = await YoutubeTranscript.fetchTranscript(ID);
  assert.deepEqual(out, [
    { text: "We're no strangers", duration: 1680, offset: 1360, lang: 'en' },
    { text: 'to love & rules', duration: 2000, offset: 3040, lang: 'en' },
  ]);
  assert.equal(calls.some((c) => c.kind === 'apify'), false);
});

test('classic format keeps seconds and decodes double-encoded entities', async () => {
  delete process.env.APIFY_TOKEN;
  stub({ innertube: () => json(tracks('en')), track: () => text(CLASSIC) });
  const out = await fetchTranscript(ID);
  assert.deepEqual(out, [{ text: "We're no strangers", duration: 1.68, offset: 1.36, lang: 'en' }]);
});

test('accepts watch, youtu.be, embed, shorts and live URLs', async () => {
  delete process.env.APIFY_TOKEN;
  stub({ innertube: () => json(tracks('en')), track: () => text(SRV3) });
  for (const url of [
    `https://www.youtube.com/watch?v=${ID}&t=10`,
    `https://youtu.be/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/live/${ID}?si=x`,
  ]) {
    await fetchTranscript(url);
    assert.equal(calls.at(-2).body.videoId, ID, url);
  }
  await assert.rejects(fetchTranscript('https://example.com/watch'), YoutubeTranscriptError);
});

test('blocked with no token throws the same error youtube-transcript throws', async () => {
  delete process.env.APIFY_TOKEN;
  stub({ innertube: BLOCKED_INNERTUBE, watch: BLOCKED_WATCH });
  await assert.rejects(fetchTranscript(ID), (e) => {
    assert.ok(e instanceof YoutubeTranscriptDisabledError);
    assert.equal(e.message, `[YoutubeTranscript] 🚨 Transcript is disabled on this video (${ID})`);
    return true;
  });
  assert.equal(calls.some((c) => c.kind === 'apify'), false);
});

test('blocked with APIFY_TOKEN falls back to the Actor and returns milliseconds', async () => {
  process.env.APIFY_TOKEN = 'test-token';
  stub({ innertube: BLOCKED_INNERTUBE, watch: BLOCKED_WATCH, apify: () => json(ACTOR_OK) });
  const out = await fetchTranscript(`https://youtu.be/${ID}`);
  assert.deepEqual(out, [
    { text: "We're no strangers", duration: 1680, offset: 1360, lang: 'en' },
    { text: 'to love & rules', duration: 2000, offset: 3040, lang: 'en' },
  ]);
  const apify = calls.find((c) => c.kind === 'apify');
  assert.equal(apify.headers.Authorization, 'Bearer test-token');
  assert.match(apify.url, /johnvc~YoutubeTranscripts\/run-sync-get-dataset-items/);
  assert.deepEqual(apify.body, {
    youtube_url: `https://www.youtube.com/watch?v=${ID}`,
    languages: ['en'],
    include_metadata: false,
  });
});

test('an empty direct result also falls back', async () => {
  stub({ innertube: () => json(tracks('en')), track: () => text('<timedtext></timedtext>'), apify: () => json(ACTOR_OK) });
  const out = await fetchTranscript(ID, { apifyToken: 'cfg-token' });
  assert.equal(out.length, 2);
  assert.equal(calls.find((c) => c.kind === 'apify').headers.Authorization, 'Bearer cfg-token');
});

test('fallback "never" behaves exactly like youtube-transcript', async () => {
  process.env.APIFY_TOKEN = 'test-token';
  stub({ innertube: BLOCKED_INNERTUBE, watch: BLOCKED_WATCH, apify: () => json(ACTOR_OK) });
  await assert.rejects(fetchTranscript(ID, { fallback: 'never' }), YoutubeTranscriptDisabledError);
  assert.equal(calls.some((c) => c.kind === 'apify'), false);
});

test('fallback "always" skips YouTube and needs a token', async () => {
  process.env.APIFY_TOKEN = 'test-token';
  stub({ apify: () => json(ACTOR_OK) });
  const out = await fetchTranscript(ID, { fallback: 'always', lang: 'en' });
  assert.equal(out.length, 2);
  assert.deepEqual(calls.map((c) => c.kind), ['apify']);
  delete process.env.APIFY_TOKEN;
  await assert.rejects(fetchTranscript(ID, { fallback: 'always' }), /no Apify token/);
});

test('a missing language is final and never triggers the fallback', async () => {
  process.env.APIFY_TOKEN = 'test-token';
  stub({ innertube: () => json(tracks('en', 'de')), watch: () => text('<html>"playabilityStatus":{}; var ytInitialPlayerResponse = ' + JSON.stringify(tracks('en', 'de')) + ';</html>') });
  await assert.rejects(fetchTranscript(ID, { lang: 'fr' }), (e) => {
    assert.ok(e instanceof YoutubeTranscriptNotAvailableLanguageError);
    assert.match(e.message, /Available languages: en, de/);
    return true;
  });
  assert.equal(calls.some((c) => c.kind === 'apify'), false);
});

test('fallback verdicts map to the original error classes', async () => {
  process.env.APIFY_TOKEN = 'test-token';
  const cases = [
    [{ error: true, error_type: 'TranscriptsDisabled' }, YoutubeTranscriptDisabledError, undefined],
    [{ error: true, error_type: 'VideoUnavailable' }, YoutubeTranscriptVideoUnavailableError, undefined],
    [
      { error: true, error_type: 'NoTranscriptFound', available_transcripts: [{ language_code: 'es' }] },
      YoutubeTranscriptNotAvailableLanguageError,
      'fr',
    ],
  ];
  for (const [row, cls, lang] of cases) {
    stub({ innertube: BLOCKED_INNERTUBE, watch: BLOCKED_WATCH, apify: () => json([row]) });
    await assert.rejects(fetchTranscript(ID, { lang }), cls);
  }
});

test('with no lang, a non-English video is retried in its first available language', async () => {
  process.env.APIFY_TOKEN = 'test-token';
  let n = 0;
  stub({
    innertube: BLOCKED_INNERTUBE,
    watch: BLOCKED_WATCH,
    apify: (body) =>
      ++n === 1
        ? json([{ error: true, error_type: 'NoTranscriptFound', available_transcripts: [{ language_code: 'es' }] }])
        : json([{ language_code: body.languages[0], timestamped: [{ text: 'hola', start: 0.5, duration: 1 }] }]),
  });
  const out = await fetchTranscript(ID);
  assert.deepEqual(out, [{ text: 'hola', duration: 1000, offset: 500, lang: 'es' }]);
  assert.deepEqual(calls.filter((c) => c.kind === 'apify').map((c) => c.body.languages), [['en'], ['es']]);
});

test('a failing fallback leaves the original error in place', async () => {
  process.env.APIFY_TOKEN = 'bad-token';
  stub({ innertube: BLOCKED_INNERTUBE, watch: BLOCKED_WATCH, apify: () => json({ error: 'unauthorized' }, 401) });
  await assert.rejects(fetchTranscript(ID), YoutubeTranscriptDisabledError);
});

test('import and require share the same classes', () => {
  const require = createRequire(import.meta.url);
  const cjs = require('../index.cjs');
  assert.equal(cjs.YoutubeTranscript, YoutubeTranscript);
  assert.equal(cjs.YoutubeTranscriptDisabledError, YoutubeTranscriptDisabledError);
});
