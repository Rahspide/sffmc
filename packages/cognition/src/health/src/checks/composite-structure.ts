// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../LICENSE

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "@sffmc/utilities";
import { packageNames, fileExists } from "../helpers.ts";
import { getHealthConfigSync } from "../config.ts";
import { createCheck } from "../check-factory.ts";

const log = createLogger("health:composite-structure");

/** Check 13: Composite structure (v0.9.0).
 *  Validates each expected composite: directory exists, package.json
 *  has matching role + (optional) composes list, src/index.ts calls
 *  `mergeHooks()` and imports from `@sffmc/utilities`. Inverse check:
 *  no module outside expectedComposites claims a role.
 *  v0.15.4 expected composites: ["safety", "memory"] (agentic was
 *  dissolved in v0.15.0; its members are now internal sub-folders
 *  of safety/memory/runtime/cognition). */
export const checkCompositeStructure = createCheck("composite_structure", async (repoRoot) => {
  const expectedComposites = getHealthConfigSync().expectedComposites
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Each expected composite exists
  for (const compositeName of expectedComposites) {
    const compositeDir = join(repoRoot, "packages", compositeName);
    if (!(await fileExists(compositeDir))) {
      errors.push(`Composite directory missing: packages/${compositeName}/`);
      continue;
    }

    // 2. package.json has role and composes
    const pkgJsonPath = join(compositeDir, "package.json");
    try {
      const content = await readFile(pkgJsonPath, "utf-8");
      const parsed = JSON.parse(content) as {
        role?: string;
        composes?: string[];
      };

      if (!parsed.role) {
        errors.push(`${compositeName}: package.json missing role`);
      } else if (parsed.role !== compositeName) {
        errors.push(`${compositeName}: package.json role is "${parsed.role}" but expected "${compositeName}"`);
      }
      // composes[] may be empty for the new layer-based layout where
      // composite members are internal sub-folders (not workspace packages).
      if (parsed.composes && parsed.composes.length > 0) {
        // 3. Each listed feature corresponds to a real package
        for (const feature of parsed.composes) {
          const featureDir = join(repoRoot, "packages", feature);
          if (!(await fileExists(featureDir))) {
            errors.push(`${compositeName} lists composes "${feature}" but packages/${feature}/ does not exist`);
          }
        }
      }
    } catch (err) {
      log.warn({ err, compositeName }, "composite-structure: composite package.json read/parse failed");
      errors.push(`${compositeName}: could not read package.json (${err})`);
    }

    // 4. src/index.ts uses mergeHooks
    const indexPath = join(compositeDir, "src", "index.ts");
    try {
      const content = await readFile(indexPath, "utf-8");
      if (!/mergeHooks\s*\(/.test(content)) {
        errors.push(`${compositeName}: src/index.ts does not call mergeHooks()`);
      }
      if (!/from\s+["']@sffmc\/utilities["']/.test(content)) {
        warnings.push(`${compositeName}: src/index.ts does not import from @sffmc/utilities`);
      }
    } catch (err) {
      log.warn({ err, compositeName }, "composite-structure: composite src/index.ts read failed");
      errors.push(`${compositeName}: could not read src/index.ts (${err})`);
    }
  }

  // 5. No module claims to be a composite (inverse check)
  for (const pkg of await packageNames(repoRoot)) {
    if (expectedComposites.includes(pkg)) continue;
    const pkgJsonPath = join(repoRoot, "packages", pkg, "package.json");
    try {
      const content = await readFile(pkgJsonPath, "utf-8");
      const parsed = JSON.parse(content) as { role?: string };
      if (parsed.role) {
        errors.push(`${pkg}: claims role "${parsed.role}" but is not in expectedComposites`);
      }
    } catch (e) {
      log.debug({ err: e, pkg }, "composite-structure: module package.json read/parse failed (other checks handle it)")
      // package.json unreadable — other checks handle this
    }
  }

  if (errors.length > 0) {
    return {
      status: "fail",
      detail: `${errors.length} composite structure error(s): ${errors.join("; ")}`,
    };
  }

  if (warnings.length > 0) {
    return {
      status: "warn",
      detail: `${expectedComposites.length} composites valid (${expectedComposites.join("/")}), ${warnings.length} warning(s): ${warnings.join("; ")}`,
    };
  }

  return {
    status: "ok",
    detail: `${expectedComposites.length} composites valid: ${expectedComposites.join(" + ")}`,
  };
});
