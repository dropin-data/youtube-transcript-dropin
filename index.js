// ESM entry: re-exports the CommonJS build so both module systems share one
// set of classes (instanceof works across import and require).
import cjs from './index.cjs';

export const {
  YoutubeTranscript,
  fetchTranscript,
  YoutubeTranscriptError,
  YoutubeTranscriptTooManyRequestError,
  YoutubeTranscriptVideoUnavailableError,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError,
} = cjs;
