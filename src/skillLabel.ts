/** How a stored skill-invocation turn reads in the chat. The stored text is
 * the literal command (`grill-apply <change>`), which is internal vocabulary;
 * rewriting at render time covers every past and future message. */
export function displaySkillCommand(text: string): string {
  const [, skill, arg] = /^\s*grill-(apply|propose)(?:\s+(\S+))?\s*$/.exec(text) ?? [];
  if (!skill) return text;
  if (skill === "propose") return "Write up the proposal";
  const name = arg?.replace(/-/g, " ");
  return name ? `Build **${name.charAt(0).toUpperCase()}${name.slice(1)}**` : "Build the proposal";
}
