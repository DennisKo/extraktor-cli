/**
 * Finds the coding agent that runs the CLI from the environment variables
 * that agents set. The server logs it, so we can see how agents use the CLI.
 * The CLI sends only the agent name, never the values of the variables.
 */
type Detector = (env: NodeJS.ProcessEnv) => boolean;

const is =
  (name: string, value: string): Detector =>
  (env) =>
    env[name] === value;

const has =
  (name: string): Detector =>
  (env) =>
    Boolean(env[name]?.trim());

const AGENTS: [string, Detector][] = [
  ["claude-code", is("CLAUDECODE", "1")],
  ["codex", has("CODEX_THREAD_ID")],
  ["cursor", is("CURSOR_AGENT", "1")],
  ["gemini-cli", is("GEMINI_CLI", "1")],
  ["opencode", is("OPENCODE", "1")],
  ["amp", has("AMP_CURRENT_THREAD_ID")],
  ["qwen-code", has("QWEN_CODE_SESSION_ID")],
  ["auggie", is("AUGMENT_AGENT", "1")],
  ["github-copilot", is("COPILOT_AGENT", "1")],
  ["warp", has("OZ_RUN_ID")],
];

const AGENT_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/iu;

/** The agent name, or null when no known agent runs the CLI. */
export const detectAgent = (env: NodeJS.ProcessEnv): string | null => {
  for (const [name, detect] of AGENTS) {
    if (detect(env)) {
      return name;
    }
  }
  // AI_AGENT is a shared convention: its value is the agent name.
  const named = env.AI_AGENT?.trim();
  return named && AGENT_NAME.test(named) ? named.toLowerCase() : null;
};
