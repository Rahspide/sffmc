import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type PluginContext } from "@sffmc/shared";

const SKILLS_DIR = join(import.meta.dirname, "..", "skills");

const VALID_SKILLS = [
  "ask",
  "brainstorm",
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

const server = async (_ctx: PluginContext) => {
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
          if (!VALID_SKILLS.includes(name)) {
            return `Error: Unknown skill "${name}". Valid skills: ${VALID_SKILLS.join(", ")}`;
          }
          const content = await readFile(
            join(SKILLS_DIR, `${name}.md`),
            "utf-8",
          );
          return content;
        },
      },
    },
  };
};

export default {
  id: "@sffmc/compose",
  server,
};
