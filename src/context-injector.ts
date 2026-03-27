/**
 * Context injection — automatically gathers relevant environment context
 * to prepend to the agent's initial prompt.
 *
 * Gathers (non-fatally): git status, recent commits, current branch,
 * directory listing, package.json name+version.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const exec = promisify(execFile);
const TIMEOUT = 3000;

async function run(cmd: string, args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await exec(cmd, args, { cwd, timeout: TIMEOUT });
    return stdout.trim();
  } catch {
    return "";
  }
}

export interface InjectedContext {
  gitBranch?: string;
  gitStatus?: string;
  recentCommits?: string;
  packageName?: string;
  packageVersion?: string;
  dirListing?: string;
}

/**
 * Gather context for the current working directory.
 * All operations are best-effort — failures return empty strings.
 */
export async function gatherContext(cwd: string): Promise<InjectedContext> {
  const [gitBranch, gitStatus, recentCommits, dirBytes] = await Promise.all([
    run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    run("git", ["status", "--short"], cwd),
    run("git", ["log", "--oneline", "-10"], cwd),
    fs.readdir(cwd).catch(() => [] as string[]),
  ]);

  // Read package.json if present
  let packageName: string | undefined;
  let packageVersion: string | undefined;
  try {
    const pkg = JSON.parse(
      await fs.readFile(path.join(cwd, "package.json"), "utf8"),
    ) as { name?: string; version?: string };
    packageName = pkg.name;
    packageVersion = pkg.version;
  } catch { /* not a Node project */ }

  const dirListing = Array.isArray(dirBytes)
    ? (dirBytes as string[]).slice(0, 30).join("  ")
    : "";

  return {
    gitBranch: gitBranch || undefined,
    gitStatus: gitStatus || undefined,
    recentCommits: recentCommits || undefined,
    packageName,
    packageVersion,
    dirListing: dirListing || undefined,
  };
}

/**
 * Format gathered context into a compact string to prepend to the prompt.
 */
export function formatContext(ctx: InjectedContext): string {
  const lines: string[] = ["[Auto-injected context]"];
  if (ctx.packageName) lines.push(`Project: ${ctx.packageName}${ctx.packageVersion ? ` v${ctx.packageVersion}` : ""}`);
  if (ctx.gitBranch)   lines.push(`Branch: ${ctx.gitBranch}`);
  if (ctx.gitStatus)   lines.push(`Git status:\n${ctx.gitStatus}`);
  if (ctx.recentCommits) lines.push(`Recent commits:\n${ctx.recentCommits}`);
  if (ctx.dirListing)  lines.push(`Directory: ${ctx.dirListing}`);
  return lines.join("\n");
}
