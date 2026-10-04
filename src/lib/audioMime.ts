/**
 * Whisper picks a decoder from the file *extension*, while `MediaRecorder`
 * reports a mime type that varies by browser and platform — Chrome says
 * `audio/webm`, Safari says `audio/mp4`, Firefox can say `audio/ogg`. Naming
 * every recording `.webm` meant a browser that recorded something else sent a
 * mislabelled file, so both ends of the upload use this instead.
 */
const EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
};

const KNOWN_EXTENSIONS = new Set(Object.values(EXTENSIONS));

/** `audio/webm;codecs=opus` and a bare `audio/webm` name the same container. */
function baseType(mime: string): string {
  return mime.split(";")[0].trim().toLowerCase();
}

export function audioFilename(mime: string, originalName?: string): string {
  const fromType = EXTENSIONS[baseType(mime)];

  if (fromType) return `voice-message.${fromType}`;

  /*
   * Some browsers hand back an empty type for a recorded blob. The name the
   * client chose is then the only hint left, and it is trusted only as far as
   * the extension: anything unrecognised falls back to the webm the recorder
   * defaults to here.
   */
  const fromName = originalName?.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();

  if (fromName && KNOWN_EXTENSIONS.has(fromName)) {
    return `voice-message.${fromName}`;
  }

  return "voice-message.webm";
}
