import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Setter } from "solid-js";
import type { TuiContext } from "./opencode";
import { isVersionNewer } from "./version";

const PACKAGE_NAME = "opencode-mini-session";
export const UPDATE_COMMAND = `opencode plugin update ${PACKAGE_NAME}`;

type PackageJson = {
  name?: string;
  version?: string;
};

export type UpdateCheckResult =
  | { updated: false }
  | { updated: true; name: string; current: string; latest: string };

export function startAutoUpdate(
  ctx: TuiContext,
  setUpdateWarning: Setter<string | undefined>,
  signal: AbortSignal,
) {
  void checkAutoUpdate(signal)
    .then((result) => handleAutoUpdateResult(ctx, result, setUpdateWarning))
    .catch(() => {});
}

export function handleAutoUpdateResult(
  ctx: Pick<TuiContext, "ui">,
  result: UpdateCheckResult,
  setUpdateWarning: (warning: string | undefined) => void,
) {
  if (!result.updated) return;

  setUpdateWarning(buildUpdateWarning(result.latest));
  ctx.ui.toast.show({
    variant: "info",
    message: `New ${result.name} ${result.latest} version available. Run \`${UPDATE_COMMAND}\` to update.`,
    duration: 8000,
  });
}

export function buildUpdateWarning(latest: string) {
  return `New version available: ${latest}. Run \`${UPDATE_COMMAND}\` to update.`;
}

export async function checkAutoUpdate(
  signal: AbortSignal,
  findDir: (startDir: string) => Promise<string | undefined> = findPackageDir,
  fetchVersion: (
    name: string,
    signal: AbortSignal,
  ) => Promise<string | undefined> = fetchLatestVersion,
): Promise<UpdateCheckResult> {
  const packageDir = await findDir(dirname(fileURLToPath(import.meta.url)));
  if (!packageDir) return { updated: false };
  if (!isNodeModulesInstall(packageDir)) return { updated: false };

  const pkg = await readPackageJson(join(packageDir, "package.json"));
  if (!pkg?.name || !pkg.version) return { updated: false };

  const latest = await fetchVersion(pkg.name, signal);
  if (!latest || !isVersionNewer(latest, pkg.version)) return { updated: false };

  return {
    updated: true,
    name: pkg.name,
    current: pkg.version,
    latest,
  };
}

export function isNodeModulesInstall(packageDir: string) {
  return packageDir.replaceAll("\\", "/").includes("/node_modules/");
}

export function parseLatestVersion(data: unknown) {
  return data &&
    typeof data === "object" &&
    typeof (data as { version?: unknown }).version === "string"
    ? (data as { version: string }).version
    : undefined;
}

async function findPackageDir(startDir: string) {
  let dir = startDir;
  for (;;) {
    const pkg = await readPackageJson(join(dir, "package.json"));
    if (pkg?.name === PACKAGE_NAME) return dir;

    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function readPackageJson(path: string): Promise<PackageJson | undefined> {
  try {
    const data = JSON.parse(await readFile(path, "utf8"));
    return data && typeof data === "object" ? (data as PackageJson) : undefined;
  } catch {
    return undefined;
  }
}

async function fetchLatestVersion(name: string, signal: AbortSignal) {
  try {
    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`,
      { signal },
    );
    if (!response.ok) return undefined;
    return parseLatestVersion(await response.json());
  } catch {
    return undefined;
  }
}
