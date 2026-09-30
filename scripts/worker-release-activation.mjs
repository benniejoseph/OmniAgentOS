/**
 * Whether a held worker's startup registration shows that this machine had
 * already activated the release it runs. Only then may a restarted process
 * resume that release's work without a new activation signal.
 */
export function registrationShowsReleaseActivation(
  body,
  { instanceId, releaseRevision },
) {
  const activation = body?.releaseActivation;
  return Boolean(instanceId && releaseRevision) &&
    activation?.instanceId === instanceId &&
    activation?.revision === releaseRevision;
}
