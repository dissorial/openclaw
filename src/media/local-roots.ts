import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

type BuildMediaLocalRootsOptions = {
  preferredTmpDir?: string;
};

let cachedPreferredTmpDir: string | undefined;

function resolveCachedPreferredTmpDir(): string {
  if (!cachedPreferredTmpDir) {
    cachedPreferredTmpDir = resolvePreferredOpenClawTmpDir();
  }
  return cachedPreferredTmpDir;
}

function buildMediaLocalRoots(
  stateDir: string,
  options: BuildMediaLocalRootsOptions = {},
): string[] {
  const resolvedStateDir = path.resolve(stateDir);
  const preferredTmpDir = options.preferredTmpDir ?? resolveCachedPreferredTmpDir();
  return [
    preferredTmpDir,
    path.join(resolvedStateDir, "media"),
    path.join(resolvedStateDir, "workspace"),
    path.join(resolvedStateDir, "sandboxes"),
  ];
}

function appendUniqueRoot(roots: string[], root: string | undefined): void {
  const trimmed = root?.trim();
  if (!trimmed) {
    return;
  }
  const normalized = path.resolve(trimmed);
  if (!roots.includes(normalized)) {
    roots.push(normalized);
  }
}

function appendConfiguredAgentWorkspaceRoots(cfg: OpenClawConfig, roots: string[]): void {
  appendUniqueRoot(roots, cfg.agents?.defaults?.workspace);
  const entries = cfg.agents?.list;
  if (!Array.isArray(entries)) {
    return;
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    appendUniqueRoot(roots, typeof entry.workspace === "string" ? entry.workspace : undefined);
  }
}

function appendConfiguredAgentTmpRoots(cfg: OpenClawConfig, roots: string[]): void {
  const entries = cfg.agents?.list;
  if (!Array.isArray(entries)) {
    return;
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
      continue;
    }
    const trimmedId = entry.id.trim();
    if (!trimmedId) {
      continue;
    }
    appendUniqueRoot(roots, path.join("/tmp", trimmedId));
  }
}

function tryLoadConfigForDefaultMediaRoots(): OpenClawConfig | undefined {
  try {
    return loadConfig();
  } catch {
    return undefined;
  }
}

export function getDefaultMediaLocalRoots(cfg?: OpenClawConfig): readonly string[] {
  const roots = buildMediaLocalRoots(resolveStateDir());
  const effectiveCfg = cfg ?? tryLoadConfigForDefaultMediaRoots();
  if (!effectiveCfg) {
    return roots;
  }
  appendConfiguredAgentWorkspaceRoots(effectiveCfg, roots);
  appendConfiguredAgentTmpRoots(effectiveCfg, roots);
  return roots;
}

export function getAgentScopedMediaLocalRoots(
  cfg: OpenClawConfig,
  agentId?: string,
): readonly string[] {
  const roots = Array.from(getDefaultMediaLocalRoots(cfg));
  const trimmedAgentId = agentId?.trim();
  if (!trimmedAgentId) {
    return roots;
  }
  const workspaceDir = resolveAgentWorkspaceDir(cfg, trimmedAgentId);
  if (!workspaceDir) {
    return roots;
  }
  const normalizedWorkspaceDir = path.resolve(workspaceDir);
  if (!roots.includes(normalizedWorkspaceDir)) {
    roots.push(normalizedWorkspaceDir);
  }
  return roots;
}

/**
 * @deprecated Kept for plugin-sdk compatibility. Media sources no longer widen allowed roots.
 */
export function appendLocalMediaParentRoots(
  roots: readonly string[],
  _mediaSources?: readonly string[],
): string[] {
  return Array.from(new Set(roots.map((root) => path.resolve(root))));
}

export function getAgentScopedMediaLocalRootsForSources({
  cfg,
  agentId,
  mediaSources: _mediaSources,
}: {
  cfg: OpenClawConfig;
  agentId?: string;
  mediaSources?: readonly string[];
}): readonly string[] {
  return getAgentScopedMediaLocalRoots(cfg, agentId);
}
