export declare class YoutubeTranscriptError extends Error {
  constructor(message: any);
}
export declare class YoutubeTranscriptTooManyRequestError extends YoutubeTranscriptError {
  constructor();
}
export declare class YoutubeTranscriptVideoUnavailableError extends YoutubeTranscriptError {
  constructor(videoId: string);
}
export declare class YoutubeTranscriptDisabledError extends YoutubeTranscriptError {
  constructor(videoId: string);
}
export declare class YoutubeTranscriptNotAvailableError extends YoutubeTranscriptError {
  constructor(videoId: string);
}
export declare class YoutubeTranscriptNotAvailableLanguageError extends YoutubeTranscriptError {
  constructor(lang: string, availableLangs: string[], videoId: string);
}
export interface TranscriptConfig {
  lang?: string;
  fetch?: typeof globalThis.fetch;
  /** Apify API token for the hosted fallback. Defaults to process.env.APIFY_TOKEN. */
  apifyToken?: string;
  /**
   * "auto" (default): fetch from YouTube directly, and use the hosted fallback
   * only when YouTube blocks the request and a token is set.
   * "always": skip the direct fetch. "never": behave exactly like youtube-transcript.
   */
  fallback?: 'auto' | 'always' | 'never';
}
export interface TranscriptResponse {
  text: string;
  duration: number;
  offset: number;
  lang?: string;
}
/**
 * Class to retrieve transcript if exist
 */
export declare class YoutubeTranscript {
  /**
   * Fetch transcript from YTB Video
   * @param videoId Video url or video identifier
   * @param config Get transcript in a specific language ISO
   */
  static fetchTranscript(videoId: string, config?: TranscriptConfig): Promise<TranscriptResponse[]>;
}
export declare function fetchTranscript(
  videoId: string,
  config?: TranscriptConfig,
): Promise<TranscriptResponse[]>;
