// Types for scripts/temp-cleanup.mjs, for the engine's tests.
export declare const PREFIXES: string[];
export declare function ownTempFolders(prefixes?: string[], dir?: string): { path: string; prefix: string; hours: number }[];
export declare function sweepOld(options?: { hours?: number; prefixes?: string[]; dir?: string }): number;
export declare function keepOnly(dir: string, keep: string[]): void;
export declare function onStop(cleanup: (signal: string) => unknown, options?: { ms?: number }): void;
export declare function orphanBrowsers(prefixes: string[], list?: { pid: number; ppid: number; command: string }[]): number[];
export declare function killOrphanBrowsers(prefixes: string[]): Promise<number>;
export declare function stopWithParent(): void;
