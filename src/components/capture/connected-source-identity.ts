export type ConnectedSourceIdentityToken = Readonly<{
  connectionId?: string;
  revision: number;
}>;

export function createConnectedSourceIdentity(initialConnectionId?: string) {
  let connectionId = initialConnectionId;
  let revision = 0;
  let active = true;

  return {
    select(nextConnectionId?: string) {
      // Reactivation must not revive work captured before an effect cleanup.
      if (!active || nextConnectionId !== connectionId) revision += 1;
      connectionId = nextConnectionId;
      active = true;
    },
    capture(): ConnectedSourceIdentityToken {
      return Object.freeze({ connectionId, revision });
    },
    isCurrent(token: ConnectedSourceIdentityToken) {
      return active
        && token.connectionId === connectionId
        && token.revision === revision;
    },
    invalidate() {
      active = false;
    },
  };
}

export async function waitForConnectedSourceClose(close: Promise<unknown>, timeoutMs = 10_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      close,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Google did not confirm that the previous Photos selection closed in time.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
