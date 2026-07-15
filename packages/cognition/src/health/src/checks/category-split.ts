// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../LICENSE

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "@sffmc/utilities";
import { packageNames } from "../helpers.ts";
import { createCheck } from "../check-factory.ts";

const log = createLogger("health:category-split");

/** Check 12: Category split (MiMo ports vs SFFMC originals).
 *  Counts packages by the `category` field in each package's `package.json`.
 *  v0.9.0 introduced MSPs; v0.14.x added `mimo-port` and `sffmc-original`.
 *  Packages missing the field land in `uncategorized` (warn).
 *  v0.15.0+ has 2 MSPs (safety/memory; agentic was dissolved in v0.15.0) - see
 *  expected-msp in the detail string for the current count. */
export const checkCategorySplit = createCheck("category_split", async (repoRoot) => {
  const counts: Record<string, { count: number; features: string[] }> = {
    "msp": { count: 0, features: [] },
    "mimo-port": { count: 0, features: [] },
    "sffmc-original": { count: 0, features: [] },
    "uncategorized": { count: 0, features: [] },
  };

  for (const pkg of await packageNames(repoRoot)) {
    if (pkg === "shared") continue;
    const pkgJsonPath = join(repoRoot, "packages", pkg, "package.json");
    try {
      const content = await readFile(pkgJsonPath, "utf-8");
      const parsed = JSON.parse(content) as { category?: string; portFeature?: string };
      const cat = parsed.category || "uncategorized";
      if (!counts[cat]) counts[cat] = { count: 0, features: [] };
      counts[cat].count++;
      if (parsed.portFeature) counts[cat].features.push(parsed.portFeature);
    } catch (e) {
      log.debug({ err: e, pkg }, "category-split: pkg package.json read/parse failed (counting as uncategorized)");
      counts.uncategorized.count++;
    }
  }

  const mspCount = counts["msp"].count;
  const portCount = counts["mimo-port"].count;
  const origCount = counts["sffmc-original"].count;
  const uncatCount = counts["uncategorized"].count;

  if (uncatCount > 0) {
    return {
      status: "warn",
      detail: `${portCount} mimo-port, ${origCount} sffmc-original, ${uncatCount} uncategorized`,
    };
  }

  return {
    status: "ok",
    detail: `${mspCount} msp + ${portCount} mimo-port + ${origCount} sffmc-original, 0 uncategorized`,
  };
});
