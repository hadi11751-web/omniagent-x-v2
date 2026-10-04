import { describe, expect, it } from "vitest";
import { audioFilename } from "@/lib/audioMime";

describe("audioFilename", () => {
  it("names each container the browsers actually record", () => {
    expect(audioFilename("audio/webm")).toBe("voice-message.webm");
    expect(audioFilename("audio/ogg")).toBe("voice-message.ogg");
    expect(audioFilename("audio/opus")).toBe("voice-message.ogg");
    expect(audioFilename("audio/mpeg")).toBe("voice-message.mp3");
    expect(audioFilename("audio/mp4")).toBe("voice-message.m4a");
    expect(audioFilename("audio/aac")).toBe("voice-message.aac");
    expect(audioFilename("audio/wav")).toBe("voice-message.wav");
    expect(audioFilename("audio/flac")).toBe("voice-message.flac");
  });

  it("ignores the codec suffix", () => {
    expect(audioFilename("audio/webm;codecs=opus")).toBe("voice-message.webm");
    expect(audioFilename("AUDIO/MP4;codecs=mp4a.40.2")).toBe("voice-message.m4a");
  });

  it("keeps a file the client already named correctly", () => {
    expect(audioFilename("", "take-3.ogg")).toBe("voice-message.ogg");
  });

  it("falls back to webm for a type it cannot read", () => {
    expect(audioFilename("")).toBe("voice-message.webm");
    expect(audioFilename("application/octet-stream", "mystery.zip")).toBe(
      "voice-message.webm",
    );
  });

  it("never passes a caller's filename through", () => {
    // The name goes to an upstream service, so it stays ours.
    expect(audioFilename("", "../../etc/passwd")).toBe("voice-message.webm");
  });
});
