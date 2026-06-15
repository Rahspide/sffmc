import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type PluginContext } from "@sffmc/shared";

const SKILLS_DIR = join(import.meta.dirname, "..", "skills");

const VALID_SKILLS = [
  "ask",
  "audit-deps",
  "benchmark",
  "brainstorm",
  "code-review",
  "debug",
  "execute",
  "feedback",
  "merge",
  "new-skill",
  "parallel",
  "plan",
  "report",
  "review",
  "subagent",
  "tdd",
  "verify",
  "worktree",
] as const;

type SkillName = (typeof VALID_SKILLS)[number];

export const id = "@sffmc/compose"
export const server = async (_ctx: PluginContext) => {
  return {
    tool: {
      compose_skill: {
        description:
          "Load a Compose Mode skill (verify/tdd/plan/etc) by name. Returns the skill's full markdown content.",
        parameters: {
          name: {
            type: "string",
            description: `Skill name: ${VALID_SKILLS.join(", ")}`,
          },
        },
        execute: async ({ name }: { name: SkillName }) => {
          if (!name || typeof name !== "string") {
            return `Error: skill name is required`;
          }
          if (!VALID_SKILLS.includes(name)) {
            return `Error: Unknown skill "${name}". Valid skills: ${VALID_SKILLS.join(", ")}`;
          }
          const filePath = join(SKILLS_DIR, `${name}.md`);
          try {
            const content = await readFile(filePath, "utf-8");
            if (content.length === 0) {
              return `Error: skill '${name}' is empty (file has no content)`;
            }
            return content;
          } catch (err) {
            return `Error: failed to load skill '${name}': ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      },
    },
  };
};

export default { id, server }
