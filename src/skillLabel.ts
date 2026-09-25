const COMMAND = /^\s*grill-(apply|propose)(?:\s+(\S+))?\s*$/;

/** `grill-apply <change>` is the literal command a Build turn stores; this is
 * the change name as a person reads it, `""` when none was given, and `null`
 * when the text isn't a Build command at all. */
export function buildTarget(text: string): string | null {
  const [, skill, arg] = COMMAND.exec(text) ?? [];
  if (skill !== "apply") return null;
  const name = arg?.replace(/-/g, " ") ?? "";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** How a stored skill-invocation turn reads in the chat. The stored text is
 * internal vocabulary; rewriting at render time covers every past and future
 * message. */
export function displaySkillCommand(text: string): string {
  const [, skill] = COMMAND.exec(text) ?? [];
  if (skill === "propose") return "Write up the proposal";
  const target = buildTarget(text);
  return target === null ? text : target ? `Build **${target}**` : "Build the proposal";
}

/** `grill-propose` is the literal command a Propose turn stores. */
export function isProposeCommand(text: string): boolean {
  return COMMAND.exec(text)?.[1] === "propose";
}
