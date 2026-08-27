type Identified = { id: string };

export function upsertById<T extends Identified>(
  items: readonly T[],
  saved: T,
): T[] {
  const index = items.findIndex((item) => item.id === saved.id);
  if (index === -1) {
    return [...items, saved];
  }

  return items.map((item, itemIndex) =>
    itemIndex === index ? saved : item,
  );
}
