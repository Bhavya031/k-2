/**
 * Startup configuration. This is the only production module that reads the
 * process environment; pass the frozen result to the rest of the application.
 */

export const modelProviders = ["anthropic", "local"] as const;
export type ModelProvider = (typeof modelProviders)[number];

type Environment = Readonly<Record<string, string | undefined>>;

export type ModelConfiguration =
  | Readonly<{ provider: "anthropic"; apiKey: string; modelName: string }>
  | Readonly<{ provider: "local"; command?: string }>;

export type MessagingConfiguration = Readonly<{
  botToken: string;
  /** Sender identifiers permitted to use phone intake; an empty list permits nobody. */
  allowedSenders: readonly string[];
}>;

export type AppConfig = Readonly<{
  databasePath: string;
  model: ModelConfiguration;
  modelMaxConcurrency?: number;
  messaging?: MessagingConfiguration;
  boundaryModel?: string;
}>;

let startupConfig: AppConfig | undefined;

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

function parseConcurrency(environment: Environment): number | undefined {
  const value = optional(environment, "MODEL_MAX_CONCURRENCY");
  if (value === undefined) {
    return undefined;
  }
  if (!/^[1-9][0-9]*$/.test(value)) {
    return configurationError(
      "MODEL_MAX_CONCURRENCY",
      "must be a positive integer",
    );
  }

  const concurrency = Number(value);
  if (!Number.isSafeInteger(concurrency)) {
    return configurationError(
      "MODEL_MAX_CONCURRENCY",
      "must be a safe integer",
    );
  }
  return concurrency;
}

function parseModelConfiguration(environment: Environment): ModelConfiguration {
  const selected = required(environment, "MODEL_PROVIDER");

  if (selected === "anthropic") {
    return Object.freeze({
      provider: "anthropic" as const,
      apiKey: required(environment, "ANTHROPIC_API_KEY"),
      modelName: required(environment, "ANTHROPIC_MODEL"),
    });
  }

  if (selected === "local") {
    const command = optional(environment, "LOCAL_MODEL_COMMAND");
    return Object.freeze({
      provider: "local" as const,
      ...(command === undefined ? {} : { command }),
    });
  }

  return configurationError(
    "MODEL_PROVIDER",
    `must be one of: ${modelProviders.join(", ")}`,
  );
}

function parseAllowedSenders(environment: Environment): readonly string[] {
  const value = optional(environment, "MESSAGING_ALLOWED_SENDERS");
  if (value === undefined) return Object.freeze([]);
  const senders = value.split(",").map((sender) => sender.trim());
  if (senders.some((sender) => sender.length === 0)) {
    return configurationError("MESSAGING_ALLOWED_SENDERS", "must be a comma-separated list without empty sender identifiers");
  }
  return Object.freeze([...new Set(senders)]);
}

function parseConfig(environment: Environment): AppConfig {
  const modelMaxConcurrency = parseConcurrency(environment);
  const botToken = optional(environment, "MESSAGING_BOT_TOKEN");
  const boundaryModel = optional(environment, "BOUNDARY_MODEL");
  const allowedSenders = parseAllowedSenders(environment);

  return Object.freeze({
    databasePath: required(environment, "DATABASE_PATH"),
    model: parseModelConfiguration(environment),
    ...(modelMaxConcurrency === undefined ? {} : { modelMaxConcurrency }),
    ...(botToken === undefined
      ? {}
      : { messaging: Object.freeze({ botToken, allowedSenders }) }),
    ...(boundaryModel === undefined ? {} : { boundaryModel }),
  });
}

/**
 * Validate the process environment exactly once at startup. Tests and startup
 * adapters may supply an explicit environment to validate it in isolation.
 */
export function loadConfig(environment?: Environment): AppConfig {
  if (environment !== undefined) {
    return parseConfig(environment);
  }

  if (startupConfig === undefined) {
    startupConfig = parseConfig(process.env);
  }
  return startupConfig;
}
