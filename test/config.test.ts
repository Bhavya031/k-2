import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config";

const baseEnvironment = { DATABASE_PATH: "/tmp/k-2.sqlite" };

describe("loadConfig", () => {
  test("returns an immutable configuration with no model capability when no provider is selected", () => {
    const config = loadConfig(baseEnvironment);

    expect(config).toEqual({ databasePath: "/tmp/k-2.sqlite", model: undefined });
    expect(Object.isFrozen(config)).toBe(true);
  });

  test("returns an immutable OpenAI capability for the closed provider selector", () => {
    const config = loadConfig({
      ...baseEnvironment,
      MODEL_PROVIDER: "openai",
      OPENAI_API_KEY: "synthetic-key",
    });

    expect(config.model).toEqual({ provider: "openai", apiKey: "synthetic-key" });
    expect(Object.isFrozen(config.model)).toBe(true);
  });

  test("returns an immutable local capability for the closed provider selector", () => {
    const config = loadConfig({
      ...baseEnvironment,
      MODEL_PROVIDER: "local",
      LOCAL_MODEL_COMMAND: "synthetic-local-model",
    });

    expect(config.model).toEqual({
      provider: "local",
      command: "synthetic-local-model",
    });
    expect(Object.isFrozen(config.model)).toBe(true);
  });

  test("names a missing required database key", () => {
    expect(() => loadConfig({})).toThrow("DATABASE_PATH");
  });

  test("names a blank required database key", () => {
    expect(() => loadConfig({ DATABASE_PATH: "   " })).toThrow("DATABASE_PATH");
  });

  test("names the provider key for an unknown provider", () => {
    expect(() =>
      loadConfig({ ...baseEnvironment, MODEL_PROVIDER: "fabricated" }),
    ).toThrow("MODEL_PROVIDER");
  });

  test("names the required API key when OpenAI is selected", () => {
    expect(() =>
      loadConfig({ ...baseEnvironment, MODEL_PROVIDER: "openai" }),
    ).toThrow("OPENAI_API_KEY");
  });

  test("names the required local command when the local provider is selected", () => {
    expect(() =>
      loadConfig({ ...baseEnvironment, MODEL_PROVIDER: "local" }),
    ).toThrow("LOCAL_MODEL_COMMAND");
  });
});
