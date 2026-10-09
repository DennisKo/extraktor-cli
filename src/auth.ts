import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { CliError, EXIT } from "./errors.ts";
import type { Credentials } from "./schemas.ts";

export const API_KEY_FORMAT = /^ext_[a-f0-9]{64}$/u;

export const credentialsPath = (env = process.env) => {
  const base =
    env.XDG_CONFIG_HOME ||
    (process.platform === "win32" && env.APPDATA) ||
    path.join(homedir(), ".config");
  return path.join(base, "extraktor", "credentials.json");
};

const readCredentials = async (file: string): Promise<Credentials> => {
  let text: string;
  try {
    text = await readFile(file, "utf-8");
  } catch {
    return {};
  }
  const { credentialsSchema } = await import("./schemas.ts");
  try {
    return credentialsSchema.parse(JSON.parse(text));
  } catch {
    throw new CliError(
      `The saved credentials are not correct: ${file}`,
      EXIT.access,
      'Delete the file, then run "extraktor login" again.'
    );
  }
};

const writeCredentials = async (file: string, credentials: Credentials) => {
  if (Object.keys(credentials).length === 0) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(credentials, null, 2)}\n`, {
    mode: 0o600,
  });
};

/** The API key for this server: EXTRAKTOR_API_KEY first, then the saved key. */
export const resolveApiKey = async (
  baseUrl: string,
  env = process.env
): Promise<string | null> => {
  if (env.EXTRAKTOR_API_KEY) {
    return env.EXTRAKTOR_API_KEY.trim();
  }
  const credentials = await readCredentials(credentialsPath(env));
  return credentials[baseUrl]?.apiKey ?? null;
};

export const saveApiKey = async (
  baseUrl: string,
  apiKey: string,
  env = process.env
) => {
  if (!API_KEY_FORMAT.test(apiKey)) {
    throw new CliError(
      "The API key is not correct. An Extraktor API key starts with ext_.",
      EXIT.usage
    );
  }
  const file = credentialsPath(env);
  const credentials = await readCredentials(file);
  await writeCredentials(file, {
    ...credentials,
    [baseUrl]: { apiKey, savedAt: new Date().toISOString() },
  });
  return file;
};

/** Deletes the saved key for this server. Returns false when there was none. */
export const deleteSavedApiKey = async (baseUrl: string, env = process.env) => {
  const file = credentialsPath(env);
  const credentials = await readCredentials(file);
  if (!credentials[baseUrl]) {
    return false;
  }
  await writeCredentials(
    file,
    Object.fromEntries(
      Object.entries(credentials).filter(([server]) => server !== baseUrl)
    )
  );
  return true;
};
