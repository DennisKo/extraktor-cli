/**
 * The agent picker for `extraktor mcp add` and `mcp remove` in a terminal.
 * Only a person sees it: the CLI loads it only when it runs in a terminal and
 * no agent runs the CLI.
 */
import { isCancel, multiselect } from "@clack/prompts";

import type { AgentId } from "./install.ts";

export interface PickerAgent {
  id: AgentId;
  name: string;
  found: boolean;
}

/** Asks which agents to change. Returns null when the person cancels. */
export type Picker = (
  action: "add" | "remove",
  agents: readonly PickerAgent[]
) => Promise<Set<AgentId> | null>;

export const pickAgents: Picker = async (action, agents) => {
  const selected = await multiselect<AgentId>({
    message:
      action === "add"
        ? "Add Extraktor to which agents?"
        : "Remove Extraktor from which agents?",
    options: agents.map(({ found, id, name }) => ({
      value: id,
      label: name,
      hint: found ? undefined : "not found on this computer",
      disabled: !found,
    })),
    initialValues: agents.flatMap(({ found, id }) => (found ? [id] : [])),
    required: true,
  });
  return isCancel(selected) ? null : new Set(selected);
};
