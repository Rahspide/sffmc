// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../LICENSE

// Check 3: readme_presence — every package must have a README.md.

import { join } from "node:path"
import { createCheck } from "../check-factory.ts"
import { checkPerPackage, fileExists } from "../helpers.ts"

export const checkReadmePresence = createCheck("readme_presence", (repoRoot) =>
  checkPerPackage(repoRoot, "README.md", (dir) => fileExists(join(dir, "README.md"))),
)
