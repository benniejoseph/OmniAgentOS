export type ResourceState<T = Record<string, unknown>> = {
  status: "idle" | "loading" | "ready" | "error" | "unavailable";
  data?: T;
  error?: string;
  stale?: boolean;
};

export function beginResourceRefresh<T>(
  current: ResourceState<T>,
): ResourceState<T> {
  return {
    status: "loading",
    data: current.data,
  };
}

export function settleResourceRefresh<T>(
  current: ResourceState<T>,
  next: ResourceState<T>,
): ResourceState<T> {
  if (next.status !== "error" || next.data || !current.data) {
    return next;
  }
  return {
    ...next,
    data: current.data,
    stale: true,
  };
}
