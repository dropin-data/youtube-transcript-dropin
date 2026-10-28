# youtube-transcript-dropin

A drop-in replacement for [`youtube-transcript`](https://www.npmjs.com/package/youtube-transcript) that keeps working once you deploy.

`youtube-transcript` works on your laptop and then fails on Vercel, Lambda, Render, Netlify or Google Cloud. It throws `Transcript is disabled on this video` or returns an empty array. The video is fine. YouTube blocks requests from datacenter IP addresses and sends back a player response with no captions in it, so new headers or client versions don't help.

This package has the same API. It still asks YouTube directly first, for free. Only when YouTube blocks the request does it fetch the transcript through a hosted service on your own Apify account.

## Migrate

```diff
- import { YoutubeTranscript } from 'youtube-transcript';
+ import { YoutubeTranscript } from 'youtube-transcript-dropin';
```

```bash
npm install youtube-transcript-dropin
```

Then set `APIFY_TOKEN` in your deployment's environment. Nothing else changes: the same `fetchTranscript` call returns the same `{ text, duration, offset, lang }` objects and throws the same error classes. `require()` works too.

```js
import { YoutubeTranscript } from 'youtube-transcript-dropin';

const transcript = await YoutubeTranscript.fetchTranscript('https://www.youtube.com/watch?v=1UL8iZJD38U');
console.log(transcript.map((line) => line.text).join(' '));
```

## How it decides

1. It fetches the transcript from YouTube the same way `youtube-transcript` 1.3.1 does.
2. If that works, you get the result and pay nothing.
3. If YouTube blocks the request (a captcha, "disabled" captions, an unavailable video, a refused caption URL or an empty result) and a token is set, it fetches the same video through the [YouTube Transcripts API](https://apify.com/johnvc/YoutubeTranscripts?fpr=9n7kx3&fp_sid=npm-yt-dropin) Actor instead.
4. If the hosted fetch can't help either, you get the original error, so your existing error handling keeps working.

A missing language (`YoutubeTranscriptNotAvailableLanguageError`) or a bad video ID never triggers the fallback.

## Options

Everything `youtube-transcript` accepts, plus two optional fields:

| Option | Default | What it does |
|---|---|---|
| `lang` | first track | Transcript language, e.g. `'en'` or `'de'`. |
| `fetch` | global `fetch` | Custom fetch for the direct YouTube requests (for example through a proxy). |
| `apifyToken` | `process.env.APIFY_TOKEN` | Token for the hosted fallback. Without one the package behaves exactly like `youtube-transcript`. |
| `fallback` | `'auto'` | `'auto'` tries YouTube first. `'always'` skips straight to the hosted fetch, which saves a round trip on servers you know are blocked. `'never'` turns the fallback off. |

## Cost

Direct fetches are free. Hosted fetches are billed to your Apify account at about $0.0025 per transcript. Videos without captions and failed fetches aren't charged. Apify's free plan includes $5 of monthly credit, which covers roughly 1,800 hosted transcripts a month.

## Differences from youtube-transcript

- `youtube.com/shorts/…` and `youtube.com/live/…` URLs are accepted.
- Timings: the direct path keeps the original behavior. That's milliseconds for the srv3 captions YouTube serves today, and seconds for the old XML format. Hosted results are always in milliseconds.
- A hosted fetch takes a few seconds, against about one second for a direct one.

## Requirements

Node 18 or later. No dependencies.

## License

MIT. The direct-fetch code is adapted from [`youtube-transcript`](https://github.com/Kakulukian/youtube-transcript) by Kakulukian (MIT).
