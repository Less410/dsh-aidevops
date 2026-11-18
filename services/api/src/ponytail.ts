import fs from "node:fs";
import path from "node:path";
import { getPonytailActivity } from "./db.js";

export const PONYTAIL_SKILLS = [
  "ponytail",
  "ponytail-review",
  "ponytail-audit",
  "ponytail-debt",
  "ponytail-gain",
  "ponytail-help",
] as const;

export const PONYTAIL_MODES = ["off", "lite", "full", "ultra"] as const;

export type PonytailSkill = (typeof PONYTAIL_SKILLS)[number];
export type PonytailMode = (typeof PONYTAIL_MODES)[number];

export function isPonytailSkill(value: unknown): value is PonytailSkill {
  return (
    typeof value === "string" &&
    (PONYTAIL_SKILLS as readonly string[]).includes(value)
  );
}

export function isPonytailMode(value: unknown): value is PonytailMode {
  return (
    typeof value === "string" &&
    (PONYTAIL_MODES as readonly string[]).includes(value)
  );
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function getPonytailStatus() {
  const checkedAt = new Date().toISOString();
  const codexHome = process.env.CODEX_HOME?.trim() || "D:\\CodexHome";
  const pluginRoot = path.join(
    codexHome,
    "plugins",
    "cache",
    "ponytail",
    "ponytail",
  );
  let version: string | null = null;
  let location: string | null = null;
  let skills: string[] = [];

  try {
    const versions = fs
      .readdirSync(pluginRoot, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort(compareVersions);
    version = versions.at(-1) ?? null;
    if (version) {
      location = path.join(pluginRoot, version, "skills");
      skills = fs
        .readdirSync(location, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            fs.existsSync(path.join(location!, entry.name, "SKILL.md")),
        )
        .map((entry) => entry.name)
        .sort();
    }
  } catch {
    // A missing install is a valid status, not an API failure.
  }

  const activity = getPonytailActivity();
  const bySkill: Record<string, number> = Object.fromEntries(
    PONYTAIL_SKILLS.map((skill) => [skill, 0]),
  );
  for (const [skill, count] of Object.entries(activity.bySkill)) {
    if (isPonytailSkill(skill)) bySkill[skill] = count;
  }

  return {
    installed: version !== null,
    complete:
      version !== null &&
      PONYTAIL_SKILLS.every((skill) => skills.includes(skill)),
    version,
    location,
    expectedSkills: [...PONYTAIL_SKILLS],
    skills,
    checkedAt,
    generatedCommands: activity.generatedCommands,
    bySkill,
    recent: activity.recent,
  };
}
