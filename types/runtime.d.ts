declare module "node:fs" {
  interface Dirent {
    readonly name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }

  export function readdirSync(
    path: string,
    options: { withFileTypes: true }
  ): Dirent[];
}

declare module "node:path" {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
}

declare interface ImportMeta {
  readonly dir: string;
}

declare const Bun: {
  spawnSync(options: {
    cmd: string[];
    cwd?: string;
    stdout?: "inherit" | "pipe";
    stderr?: "inherit" | "pipe";
  }): { exitCode: number };
};

declare const process: {
  readonly execPath: string;
  exit(code?: number): never;
};
