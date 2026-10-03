/** A late permission result belongs to the attempt that requested it. Dispose
 * its tracks before any recorder/transport can adopt it after cancellation. */
export async function requestCurrentMicrophone<T extends { getTracks(): Array<{ stop(): void }> }>(
  request: () => Promise<T>, isCurrent: () => boolean,
): Promise<T | undefined> {
  const stream = await request();
  if (isCurrent()) return stream;
  stream.getTracks().forEach((track) => track.stop());
  return undefined;
}
