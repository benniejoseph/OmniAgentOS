/**
 * Shown inside the workspace shell while a workspace view renders on the
 * server. Being a loading boundary also lets a hover or focus prefetch fetch
 * the route down to here, so opening a workspace shows this at once.
 */
export default function WorkspaceLoading() {
  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6" role="status" aria-busy="true">
      <span className="sr-only">Loading the workspace.</span>
      <div aria-hidden="true">
        <div className="h-7 w-48 animate-pulse rounded-md bg-surface-raised motion-reduce:animate-none" />
        <div className="mt-3 h-4 w-72 max-w-full animate-pulse rounded-md bg-surface-raised motion-reduce:animate-none" />
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="h-32 animate-pulse rounded-lg border border-line bg-surface motion-reduce:animate-none" />
          ))}
        </div>
      </div>
    </section>
  );
}
