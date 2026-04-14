import { describe, it, expect } from "vitest";
import { getMimeFromFilename, getExtensionFromMime, getExtensionFromContentTypeOrUrl } from "./mime.js";

describe("getMimeFromFilename", () => {
  it("returns correct MIME for known extensions", () => {
    expect(getMimeFromFilename("photo.png")).toBe("image/png");
    expect(getMimeFromFilename("doc.pdf")).toBe("application/pdf");
    expect(getMimeFromFilename("video.mp4")).toBe("video/mp4");
    expect(getMimeFromFilename("audio.mp3")).toBe("audio/mpeg");
    expect(getMimeFromFilename("image.jpg")).toBe("image/jpeg");
    expect(getMimeFromFilename("image.jpeg")).toBe("image/jpeg");
    expect(getMimeFromFilename("data.csv")).toBe("text/csv");
  });

  it("is case-insensitive", () => {
    expect(getMimeFromFilename("PHOTO.PNG")).toBe("image/png");
    expect(getMimeFromFilename("file.PDF")).toBe("application/pdf");
  });

  it("returns application/octet-stream for unknown extensions", () => {
    expect(getMimeFromFilename("file.xyz")).toBe("application/octet-stream");
    expect(getMimeFromFilename("noext")).toBe("application/octet-stream");
  });

  it("handles paths with directories", () => {
    expect(getMimeFromFilename("/path/to/photo.png")).toBe("image/png");
  });
});

describe("getExtensionFromMime", () => {
  it("returns correct extension for known MIME types", () => {
    expect(getExtensionFromMime("image/jpeg")).toBe(".jpg");
    expect(getExtensionFromMime("image/png")).toBe(".png");
    expect(getExtensionFromMime("video/mp4")).toBe(".mp4");
    expect(getExtensionFromMime("application/pdf")).toBe(".pdf");
  });

  it("handles MIME with parameters", () => {
    expect(getExtensionFromMime("image/jpeg; charset=utf-8")).toBe(".jpg");
    expect(getExtensionFromMime("text/plain; boundary=something")).toBe(".txt");
  });

  it("returns .bin for unknown MIME types", () => {
    expect(getExtensionFromMime("application/unknown")).toBe(".bin");
    expect(getExtensionFromMime("x-custom/type")).toBe(".bin");
  });

  it("handles image/jpg alias", () => {
    expect(getExtensionFromMime("image/jpg")).toBe(".jpg");
  });
});

describe("getExtensionFromContentTypeOrUrl", () => {
  it("prefers Content-Type when it resolves to a known extension", () => {
    expect(getExtensionFromContentTypeOrUrl("image/png", "https://example.com/file.jpg")).toBe(".png");
  });

  it("falls back to URL extension when Content-Type is unknown", () => {
    expect(getExtensionFromContentTypeOrUrl("application/unknown", "https://example.com/file.jpg")).toBe(".jpg");
  });

  it("falls back to URL extension when Content-Type is null", () => {
    expect(getExtensionFromContentTypeOrUrl(null, "https://example.com/file.mp4")).toBe(".mp4");
  });

  it("returns .bin when neither Content-Type nor URL has a known extension", () => {
    expect(getExtensionFromContentTypeOrUrl(null, "https://example.com/file")).toBe(".bin");
    expect(getExtensionFromContentTypeOrUrl("application/unknown", "https://example.com/file.xyz")).toBe(".bin");
  });

  it("handles URL with query parameters", () => {
    expect(getExtensionFromContentTypeOrUrl(null, "https://example.com/file.png?token=abc")).toBe(".png");
  });
});
