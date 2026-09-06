/**
 * Startup configuration.  This is the only production module that reads the
 * process environment; pass its result to the rest of the application.
 */

export const modelProviders = ["openai", "local"] as const;
export type ModelProvider = (typeof modelProviders)[number];

type Environment = Readonly<Record<string, string | undefined>>;

export type ModelConfiguration =
  | Readonly<{ provider: "openai"; apiKey: string }>
  | Readonly<{ provider: "local"; command: string }>;

export type AppConfig = Readonly<{
  databasePath: string;
  model?: ModelConfiguration;
}>;

function configurationError(key: string, detail: string): never {
  throw new Error(`Configuration error: ${key} ${detail}`);
}

function required(environment: Environment, key: string): string {
  const value = environment[key];
  if (value === undefined || value.trim() === "") {
    return configurationError(key, "is required");
  }
  return value;
}

function optional(environment: Environment, key: string): string | undefined {
  const value = environment[key];
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return value;
}

function parseModelConfiguration(environment: Environment): ModelConfiguration | undefined {
  const selected = optional(environment, "MODEL_PROVIDER");
  if (selected === undefined) {
    return undefined;
  }

  if (selected === "openai") {
    return Object.freeze({
      provider: "openai" as const,
      apiKey: required(environment, "OPENAI_API_KEY"),
    });
  }

  if (selected === "local") {
    return Object.freeze({
      provider: "local" as const,
      command: required(environment, "LOCAL_MODEL_COMMAND"),
    });
  }

  return configurationError(
    "MODEL_PROVIDER",
    `must be one of: ${modelProviders.join(", ")}`,
  );
}

/**
 * Validate the environment once during application startup.  The returned
 * object is immutable so downstream code cannot alter the selected capability.
 */
export function loadConfig(environment: Environment = process.env): AppConfig {
  return Object.freeze({
    databasePath: required(environment, "DATABASE_PATH"),
    model: parseModelConfiguration(environment),
  });
}
