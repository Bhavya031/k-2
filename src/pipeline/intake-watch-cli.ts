import { defaultIntakeFolders, createIntakeWatcher, watchIntakeFolders, type IntakeFolders, type IntakePollResult, type IntakeWatchDependencies } from "./intake-watch.ts";

const watchOptions = new Set(["--intake-dir", "--processed-dir", "--failed-dir", "--poll-ms"]);
export type IntakeWatchCommandDependencies = IntakeWatchDependencies & Readonly<{ write?: (contents: string) => void }>;

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}

function pollMilliseconds(args: readonly string[]): number {
  const value = option(args, "--poll-ms") ?? "1000";
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("--poll-ms must be a positive integer");
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds)) throw new Error("--poll-ms must be a safe integer");
  return milliseconds;
}

function batchArguments(args: readonly string[]): readonly string[] {
  const forwarded: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--once") continue;
    if (watchOptions.has(argument)) {
      index += 1;
      continue;
    }
    if (argument === "--pdf") throw new Error("--pdf is supplied by the intake watcher");
    forwarded.push(argument);
  }
  return Object.freeze(forwarded);
}

export function intakeFoldersFromArguments(args: readonly string[]): IntakeFolders {
  return Object.freeze({
    intake: option(args, "--intake-dir") ?? defaultIntakeFolders.intake,
    processed: option(args, "--processed-dir") ?? defaultIntakeFolders.processed,
    failed: option(args, "--failed-dir") ?? defaultIntakeFolders.failed,
  });
}

/**
 * `bun run watch-intake -- --payment-run-id ... --payment-run-on ... --matched-on ... --reviewed-at ...`
 * polls ./intake, moves successes to ./processed, and failures plus .error.txt
 * sidecars to ./failed. Folder and interval options are documented in
 * docs/intake-watch.md.
 */
export async function runIntakeWatchCommand(args: readonly string[], dependencies: IntakeWatchCommandDependencies = {}): Promise<void> {
  const folders = intakeFoldersFromArguments(args);
  const forwarded = batchArguments(args);
  const write = dependencies.write ?? ((contents: string) => process.stdout.write(contents));
  const report = (result: IntakePollResult) => write(`${JSON.stringify(result)}\n`);
  if (args.includes("--once")) {
    report(await createIntakeWatcher(folders, forwarded, dependencies).poll());
    return;
  }
  await watchIntakeFolders(folders, forwarded, pollMilliseconds(args), { ...dependencies, onPoll: report });
}

void (async () => {
  if (import.meta.main) await runIntakeWatchCommand(process.argv.slice(2));
})();
