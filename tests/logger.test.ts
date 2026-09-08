import { describe, expect, test } from "bun:test";
import { redact, redactKeysMatching } from "../src/logger.js";

describe("redact", () => {
  test("masks sensitive keys at any depth", () => {
    expect(redact({ TELEGRAM_BOT_TOKEN: "123:abc", nested: { apiKey: "x", keep: 1 } })).toEqual({
      TELEGRAM_BOT_TOKEN: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", keep: 1 },
    });
  });

  test("masks inside arrays", () => {
    expect(redact([{ password: "p" }])).toEqual([{ password: "[REDACTED]" }]);
  });

  test("serializes errors", () => {
    const result = redact(new Error("boom")) as { name: string; message: string };
    expect(result.name).toBe("Error");
    expect(result.message).toBe("boom");
  });

  test("masks keys added by a project", () => {
    redactKeysMatching(/ssecurity|download_url/i);
    expect(redact({ ssecurity: "x", download_url: "https://signed", plain: "ok" })).toEqual({
      ssecurity: "[REDACTED]",
      download_url: "[REDACTED]",
      plain: "ok",
    });
  });

  test("passes primitives through", () => {
    expect(redact("plain")).toBe("plain");
    expect(redact(null)).toBeNull();
  });
});
