'use strict';
// youtube-transcript-dropin: the youtube-transcript API, with a hosted fallback
// for the servers YouTube blocks. The direct path is adapted from
// youtube-transcript 1.3.1 by Kakulukian (MIT); see LICENSE.

const RE_YOUTUBE =
  /(?:youtube\.com\/(?:shorts\/|live\/|[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.83 Safari/537.36,gzip(gfe)';
const RE_XML_TRANSCRIPT = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;

const INNERTUBE_API_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const INNERTUBE_CLIENT_VERSION = '20.10.38';
const INNERTUBE_CONTEXT = {
  client: { clientName: 'ANDROID', clientVersion: INNERTUBE_CLIENT_VERSION },
};
const INNERTUBE_USER_AGENT = `com.google.android.youtube/${INNERTUBE_CLIENT_VERSION} (Linux; U; Android 14)`;

const APIFY_ACTOR_URL =
  'https://api.apify.com/v2/acts/johnvc~YoutubeTranscripts/run-sync-get-dataset-items';
const APIFY_TIMEOUT_SECS = 120;

class YoutubeTranscriptError extends Error {
  constructor(message) {
    super(`[YoutubeTranscript] 🚨 ${message}`);
  }
}

class YoutubeTranscriptTooManyRequestError extends YoutubeTranscriptError {
  constructor() {
    super(
      'YouTube is receiving too many requests from this IP and now requires solving a captcha to continue',
    );
  }
}

class YoutubeTranscriptVideoUnavailableError extends YoutubeTranscriptError {
  constructor(videoId) {
    super(`The video is no longer available (${videoId})`);
  }
}

class YoutubeTranscriptDisabledError extends YoutubeTranscriptError {
  constructor(videoId) {
    super(`Transcript is disabled on this video (${videoId})`);
  }
}

class YoutubeTranscriptNotAvailableError extends YoutubeTranscriptError {
  constructor(videoId) {
    super(`No transcripts are available for this video (${videoId})`);
  }
}

class YoutubeTranscriptNotAvailableLanguageError extends YoutubeTranscriptError {
  constructor(lang, availableLangs, videoId) {
    super(
      `No transcripts are available in ${lang} this video (${videoId}). Available languages: ${availableLangs.join(
        ', ',
      )}`,
    );
  }
}

// Errors YouTube also produces when it blocks the caller's IP instead of
// serving captions. Anything else (bad ID, missing language) is final.
const BLOCK_SHAPED_ERRORS = [
  YoutubeTranscriptTooManyRequestError,
  YoutubeTranscriptVideoUnavailableError,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
];

function isBlockShaped(error) {
  if (!(error instanceof YoutubeTranscriptError)) return true; // network failure
  return BLOCK_SHAPED_ERRORS.some((cls) => error instanceof cls);
}

function apifyToken(config) {
  if (config && config.apifyToken) return config.apifyToken;
  if (typeof process !== 'undefined' && process.env) return process.env.APIFY_TOKEN || '';
  return '';
}

class YoutubeTranscript {
  /**
   * Fetch transcript from YTB Video
   * @param videoId Video url or video identifier
   * @param config Get transcript in a specific language ISO
   */
  static async fetchTranscript(videoId, config) {
    const identifier = this.retrieveVideoId(videoId);
    const mode = (config && config.fallback) || 'auto';
    const token = apifyToken(config);

    if (mode === 'always') {
      if (!token) {
        throw new YoutubeTranscriptError(
          'fallback is "always" but no Apify token was given (set APIFY_TOKEN or config.apifyToken).',
        );
      }
      return this.fetchViaApify(identifier, videoId, token, config);
    }

    let directError;
    try {
      const direct = await this.fetchDirect(identifier, videoId, config);
      if (direct.length > 0 || mode === 'never' || !token) return direct;
    } catch (error) {
      if (mode === 'never' || !token || !isBlockShaped(error)) throw error;
      directError = error;
    }

    try {
      return await this.fetchViaApify(identifier, videoId, token, config);
    } catch (error) {
      // A real answer from the fallback (no captions, wrong language) beats the
      // direct path's guess; a failed fallback leaves the direct result standing.
      if (error.fromFallbackVerdict) throw error;
      if (directError) throw directError;
      return [];
    }
  }

  static async fetchDirect(identifier, videoId, config) {
    const innerTubeResult = await this.fetchViaInnerTube(identifier, config);
    if (innerTubeResult) return innerTubeResult;
    return this.fetchViaWebPage(identifier, videoId, config);
  }

  /**
   * Fetch transcript via the InnerTube API (Android client context)
   */
  static async fetchViaInnerTube(identifier, config) {
    try {
      const fetchFn = (config && config.fetch) || fetch;
      const resp = await fetchFn(INNERTUBE_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': INNERTUBE_USER_AGENT },
        body: JSON.stringify({ context: INNERTUBE_CONTEXT, videoId: identifier }),
      });
      if (!resp.ok) return undefined;
      const data = await resp.json();
      const captionTracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!Array.isArray(captionTracks) || captionTracks.length === 0) return undefined;
      return await this.fetchTranscriptFromTracks(captionTracks, identifier, config);
    } catch {
      return undefined;
    }
  }

  /**
   * Fetch transcript via web page HTML scraping (fallback)
   */
  static async fetchViaWebPage(identifier, originalVideoId, config) {
    const fetchFn = (config && config.fetch) || fetch;
    const videoPageResponse = await fetchFn(`https://www.youtube.com/watch?v=${identifier}`, {
      headers: {
        ...(config?.lang && { 'Accept-Language': config.lang }),
        'User-Agent': USER_AGENT,
      },
    });
    const videoPageBody = await videoPageResponse.text();

    if (videoPageBody.includes('class="g-recaptcha"')) {
      throw new YoutubeTranscriptTooManyRequestError();
    }
    if (!videoPageBody.includes('"playabilityStatus":')) {
      throw new YoutubeTranscriptVideoUnavailableError(originalVideoId);
    }

    const playerResponse = this.parseInlineJson(videoPageBody, 'ytInitialPlayerResponse');
    const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(captionTracks) || captionTracks.length === 0) {
      throw new YoutubeTranscriptDisabledError(originalVideoId);
    }
    return this.fetchTranscriptFromTracks(captionTracks, originalVideoId, config);
  }

  /**
   * Fetch the transcript through the johnvc/YoutubeTranscripts Actor on Apify,
   * billed to the caller's Apify account. Offsets and durations are returned in
   * milliseconds, like the srv3 captions the direct path reads.
   */
  static async fetchViaApify(identifier, originalVideoId, token, config) {
    const wanted = config?.lang;
    let row = await this.runActor(identifier, wanted ? [wanted] : ['en'], token);

    if (row.error && row.error_type === 'NoTranscriptFound') {
      const available = (row.available_transcripts || [])
        .map((t) => t.language_code)
        .filter(Boolean);
      if (wanted) {
        throw verdict(new YoutubeTranscriptNotAvailableLanguageError(wanted, available, originalVideoId));
      }
      // The original returns the first track whatever its language.
      if (available.length > 0) row = await this.runActor(identifier, [available[0]], token);
    }

    if (row.error) {
      switch (row.error_type) {
        case 'TranscriptsDisabled':
        case 'NoTranscriptFound':
          throw verdict(new YoutubeTranscriptDisabledError(originalVideoId));
        case 'VideoUnavailable':
        case 'InvalidVideoId':
          throw verdict(new YoutubeTranscriptVideoUnavailableError(originalVideoId));
        default:
          throw new YoutubeTranscriptNotAvailableError(originalVideoId);
      }
    }

    const lang = wanted ?? row.language_code;
    return (row.timestamped || [])
      .map((s) => ({
        text: String(s.text ?? '').trim(),
        duration: Math.round(Number(s.duration) * 1000),
        offset: Math.round(Number(s.start) * 1000),
        lang,
      }))
      .filter((s) => s.text);
  }

  static async runActor(identifier, languages, token) {
    const resp = await fetch(`${APIFY_ACTOR_URL}?timeout=${APIFY_TIMEOUT_SECS}&clean=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        youtube_url: `https://www.youtube.com/watch?v=${identifier}`,
        languages,
        include_metadata: false,
      }),
    });
    if (!resp.ok) {
      throw new YoutubeTranscriptError(`Apify fallback failed with HTTP ${resp.status}.`);
    }
    const rows = await resp.json();
    const row = Array.isArray(rows) ? rows.find((r) => r && (r.timestamped || r.error)) : undefined;
    if (!row) throw new YoutubeTranscriptError('Apify fallback returned no transcript row.');
    return row;
  }

  /**
   * Extract a JSON object assigned to a global variable in inline script tags
   */
  static parseInlineJson(html, globalName) {
    const startToken = `var ${globalName} = `;
    const startIndex = html.indexOf(startToken);
    if (startIndex === -1) return null;
    const jsonStart = startIndex + startToken.length;
    let depth = 0;
    for (let i = jsonStart; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(html.slice(jsonStart, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }

  /**
   * Given caption tracks, select the right one, fetch and parse the transcript XML
   */
  static async fetchTranscriptFromTracks(captionTracks, videoId, config) {
    if (config?.lang && !captionTracks.some((track) => track.languageCode === config.lang)) {
      throw new YoutubeTranscriptNotAvailableLanguageError(
        config.lang,
        captionTracks.map((track) => track.languageCode),
        videoId,
      );
    }
    const track = config?.lang
      ? captionTracks.find((t) => t.languageCode === config.lang)
      : captionTracks[0];
    const transcriptURL = track.baseUrl;

    // Validate URL to prevent SSRF
    try {
      const captionUrl = new URL(transcriptURL);
      if (!captionUrl.hostname.endsWith('.youtube.com')) {
        throw new YoutubeTranscriptNotAvailableError(videoId);
      }
    } catch (e) {
      if (e instanceof YoutubeTranscriptError) throw e;
      throw new YoutubeTranscriptNotAvailableError(videoId);
    }
    const fetchFn = (config && config.fetch) || fetch;
    const transcriptResponse = await fetchFn(transcriptURL, {
      headers: {
        ...(config?.lang && { 'Accept-Language': config.lang }),
        'User-Agent': USER_AGENT,
      },
    });
    if (!transcriptResponse.ok) throw new YoutubeTranscriptNotAvailableError(videoId);
    const transcriptBody = await transcriptResponse.text();
    const lang = config?.lang ?? captionTracks[0].languageCode;
    return this.parseTranscriptXml(transcriptBody, lang);
  }

  /**
   * Parse transcript XML, supporting both srv3 format (<p t="ms">) and
   * classic format (<text start="s" dur="s">)
   */
  static parseTranscriptXml(xml, lang) {
    const results = [];
    const pRegex = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
    let match;
    while ((match = pRegex.exec(xml)) !== null) {
      const startMs = parseInt(match[1], 10);
      const durMs = parseInt(match[2], 10);
      const inner = match[3];
      let text = '';
      const sRegex = /<s[^>]*>([^<]*)<\/s>/g;
      let sMatch;
      while ((sMatch = sRegex.exec(inner)) !== null) text += sMatch[1];
      if (!text) text = inner.replace(/<[^>]+>/g, '');
      text = this.decodeEntities(text).trim();
      if (text) results.push({ text, duration: durMs, offset: startMs, lang });
    }
    if (results.length > 0) return results;

    return [...xml.matchAll(RE_XML_TRANSCRIPT)].map((result) => ({
      text: this.decodeEntities(result[3]),
      duration: parseFloat(result[2]),
      offset: parseFloat(result[1]),
      lang,
    }));
  }

  /**
   * Decode common HTML entities in transcript text
   */
  static decodeEntities(text) {
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
  }

  /**
   * Retrieve video id from url or string
   * @param videoId video url or video id
   */
  static retrieveVideoId(videoId) {
    if (videoId.length === 11) return videoId;
    const matchId = videoId.match(RE_YOUTUBE);
    if (matchId && matchId.length) return matchId[1];
    throw new YoutubeTranscriptError('Impossible to retrieve Youtube video ID.');
  }
}

// Marks an error as the fallback's real answer about the video, as opposed to
// the fallback itself failing.
function verdict(error) {
  error.fromFallbackVerdict = true;
  return error;
}

function fetchTranscript(videoId, config) {
  return YoutubeTranscript.fetchTranscript(videoId, config);
}

module.exports = {
  YoutubeTranscript,
  fetchTranscript,
  YoutubeTranscriptError,
  YoutubeTranscriptTooManyRequestError,
  YoutubeTranscriptVideoUnavailableError,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError,
};
