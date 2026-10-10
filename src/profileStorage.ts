/** The native identity selects one immutable browser-storage namespace. */
let profile: string | null = null;
const scoped = (key: string) =>
  profile
    ? `palisade-profile:${profile}:${key}`
    : import.meta.env.MODE === "test"
      ? key
      : null;
export function bindProfileStorage(key: string, importLegacy = false) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid profile identity");
  if (profile && profile !== key)
    throw new Error("Restart before switching profiles");
  if (importLegacy) {
    const marker = `palisade-profile:${key}:import-complete`;
    if (window.localStorage.getItem(marker) !== "1") {
      const keys = Object.keys(window.localStorage).filter((name) =>
        name.startsWith("palisade:")
      );
      const created: string[] = [];
      try {
        for (const name of keys) {
          const value = window.localStorage.getItem(name)!;
          const target = `palisade-profile:${key}:${name}`;
          const existing = window.localStorage.getItem(target);
          if (existing !== null && existing !== value)
            throw new Error("Import would overwrite profile preferences");
          if (existing === null) created.push(target);
          window.localStorage.setItem(target, value);
          if (window.localStorage.getItem(target) !== value)
            throw new Error("Could not verify imported preferences");
        }
        window.localStorage.setItem(marker, "1");
        if (window.localStorage.getItem(marker) !== "1")
          throw new Error("Could not verify the preference import");
      } catch (failure) {
        for (const target of created) window.localStorage.removeItem(target);
        window.localStorage.removeItem(marker);
        throw failure;
      }
    }
  }
  profile = key;
}
export const profileStorage = {
  getItem(key: string) {
    const name = scoped(key);
    return name ? window.localStorage.getItem(name) : null;
  },
  setItem(key: string, value: string) {
    const name = scoped(key);
    if (name) window.localStorage.setItem(name, value);
  },
  removeItem(key: string) {
    const name = scoped(key);
    if (name) window.localStorage.removeItem(name);
  },
};

export const hasImportedPreferences = (key: string) =>
  window.localStorage.getItem(`palisade-profile:${key}:import-complete`) ===
  "1";
