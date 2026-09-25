export type SpecLink = { id?: string; name: string | null };

/** A proposal that links to the thread already on screen opens its viewer.
 * Selecting a thread that was linked all along, or switching threads, does not. */
export const shouldOpenLinkedSpec = (prev: SpecLink, next: SpecLink) =>
  !!next.name && prev.id === next.id && !prev.name;
