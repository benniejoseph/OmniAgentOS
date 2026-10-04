/** Collection authorization failure fences every in-flight read in this mount. */
export function createLibraryReadAccess() {
  let generation = 0, blocked = false;
  const controllers = new Set<AbortController>();
  const abortAll = () => { controllers.forEach((controller) => controller.abort()); controllers.clear(); generation++; };
  return {
    begin() {
      if (blocked) return undefined;
      const token = { generation, controller: new AbortController() };
      controllers.add(token.controller);
      return token;
    },
    current(token: { generation: number; controller: AbortController }) {
      return !blocked && generation === token.generation && !token.controller.signal.aborted;
    },
    cancel(token: { controller: AbortController }) { token.controller.abort(); controllers.delete(token.controller); },
    revoke() { blocked = true; abortAll(); },
    retry() { abortAll(); blocked = false; },
  };
}
