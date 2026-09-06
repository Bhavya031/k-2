import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config";

const baseEnvironment = {
  DATABASE_PATH: "/tmp/k-2.sqlite",
  MODEL_PROVIDER: "anthropic",
  ANTHROPIC_API_KEY: "synthetic-key",
  ANTHROPIC_MODEL: "synthetic-model",
};

describe("loadConfig", () => {
  test("returns an immutable Anthropic configuration", () => {
    const config = loadConfig(baseEnvironment);

    expect(config).toEqual({
      databasePath: "/tmp/k-2.sqlite",
      model: {
        provider: "anthropic",
        apiKey: "synthetic-key",
        modelName: "synthetic-model",
      },
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.model)).toBe(true);
  });

  test("accepts the local binary fallback without an optional command", () => {
    const config = loadConfig({
      DATABASE_PATH: "/tmp/k-2.sqlite",
      MODEL_PROVIDER: "local",
    });

    expect(config).toEqual({
      databasePath: "/tmp/k-2.sqlite",
      model: { provider: "local" },
    });
  });

  test("keeps an explicitly configured local binary command", () => {
    const config = loadConfig({
      DATABASE_PATH: "/tmp/k-2.sqlite",
      MODEL_PROVIDER: "local",
      LOCAL_MODEL_COMMAND: "synthetic-local-model",
    });

    expect(config.model).toEqual({
      provider: "local",
      command: "synthetic-local-model",
    });
    expect(Object.isFrozen(config.model)).toBe(true);
  });

  test("adds each optional capability only when its key is configured", () => {
    const config = loadConfig({
      ...baseEnvironment,
      MODEL_MAX_CONCURRENCY: "4",
      MESSAGING_BOT_TOKEN: "synthetic-bot-token",
      MESSAGING_ALLOWED_SENDERS: "synthetic-driver-1, synthetic-driver-2, synthetic-driver-1",
      BOUNDARY_MODEL: "synthetic-boundary-model",
      GMAIL_CLIENT_ID: "synthetic-client-id",
      GMAIL_CLIENT_SECRET: "synthetic-client-secret",
      GMAIL_REFRESH_TOKEN: "synthetic-refresh-token",
    });

    expect(config.modelMaxConcurrency).toBe(4);
    expect(config.messaging).toEqual({ botToken: "synthetic-bot-token", allowedSenders: ["synthetic-driver-1", "synthetic-driver-2"] });
    expect(config.boundaryModel).toBe("synthetic-boundary-model");
    expect(config.gmailIntake).toEqual({ clientId: "synthetic-client-id", clientSecret: "synthetic-client-secret", refreshToken: "synthetic-refresh-token" });
    expect(Object.isFrozen(config.messaging)).toBe(true);
    expect(Object.isFrozen(config.gmailIntake)).toBe(true);
  });

  test("leaves optional capabilities absent when their keys are missing", () => {
    const config = loadConfig(baseEnvironment);

    expect("modelMaxConcurrency" in config).toBe(false);
    expect("messaging" in config).toBe(false);
    expect("boundaryModel" in config).toBe(false);
    expect("gmailIntake" in config).toBe(false);
  });

  test("names a missing required database key", () => {
    expect(() => loadConfig({ ...baseEnvironment, DATABASE_PATH: "" })).toThrow(
      "DATABASE_PATH",
    );
  });

  test("names a missing required provider key", () => {
    const { MODEL_PROVIDER: _provider, ...environment } = baseEnvironment;

    expect(() => loadConfig(environment)).toThrow("MODEL_PROVIDER");
  });

  test("names the provider key for an unknown provider", () => {
    expect(() =>
      loadConfig({ ...baseEnvironment, MODEL_PROVIDER: "fabricated" }),
    ).toThrow("MODEL_PROVIDER");
  });

  test("names the required Anthropic API key", () => {
    const { ANTHROPIC_API_KEY: _key, ...environment } = baseEnvironment;

    expect(() => loadConfig(environment)).toThrow("ANTHROPIC_API_KEY");
  });

  test("names the required Anthropic model key", () => {
    const { ANTHROPIC_MODEL: _model, ...environment } = baseEnvironment;

    expect(() => loadConfig(environment)).toThrow("ANTHROPIC_MODEL");
  });

  test.each(["0", "2.5", "unlimited"]) (
    "names the concurrency key for malformed optional value %p",
    (value) => {
      expect(() =>
        loadConfig({ ...baseEnvironment, MODEL_MAX_CONCURRENCY: value }),
      ).toThrow("MODEL_MAX_CONCURRENCY");
    },
  );

  test("rejects blank sender identifiers in the optional messaging allow-list", () => {
    expect(() => loadConfig({ ...baseEnvironment, MESSAGING_BOT_TOKEN: "synthetic-token", MESSAGING_ALLOWED_SENDERS: "synthetic-driver-1,,synthetic-driver-2" })).toThrow("MESSAGING_ALLOWED_SENDERS");
  });

  test("requires every Gmail intake credential once any Gmail intake key is configured", () => {
    expect(() => loadConfig({ ...baseEnvironment, GMAIL_CLIENT_ID: "synthetic-client-id" })).toThrow("GMAIL_CLIENT_SECRET");
  });

});
