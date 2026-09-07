import * as api from "./api";

export const PROJECT_SETTINGS_FILE = ".palisade/project-settings.json";

type ProjectSettings = Record<string, unknown>;

function isMissingFile(error: unknown) {
  return /no such file|not found|os error 2/i.test(String(error));
}

/**
 * Changes one setting without giving any caller a chance to replace the rest
 * of the project file. A malformed non-empty file is deliberately left alone:
 * settings edits must not turn a recoverable parse error into data loss.
 */
export async function updateProjectSettings(
  projectHash: string,
  update: (settings: ProjectSettings) => void
): Promise<ProjectSettings> {
  let previous: string | null = null;
  try {
    previous = await api.readFileContent(projectHash, PROJECT_SETTINGS_FILE);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const parsed: unknown = previous?.trim() ? JSON.parse(previous) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Project settings must be a JSON object");
  }

  const settings = parsed as ProjectSettings;
  update(settings);
  await api.writeFileContent(
    projectHash,
    PROJECT_SETTINGS_FILE,
    JSON.stringify(settings, null, 2) + "\n",
    previous
  );
  return settings;
}
