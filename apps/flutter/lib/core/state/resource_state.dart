sealed class ResourceState<T> {
  const ResourceState();

  R when<R>({
    required R Function() idle,
    required R Function() loading,
    required R Function(T data) ready,
    required R Function(Object error) failed,
  }) => switch (this) {
    ResourceIdle<T>() => idle(),
    ResourceLoading<T>() => loading(),
    ResourceReady<T>(:final data) => ready(data),
    ResourceFailed<T>(:final error) => failed(error),
  };
}

final class ResourceIdle<T> extends ResourceState<T> {
  const ResourceIdle();
}

final class ResourceLoading<T> extends ResourceState<T> {
  const ResourceLoading();
}

final class ResourceReady<T> extends ResourceState<T> {
  const ResourceReady(this.data);
  final T data;
}

final class ResourceFailed<T> extends ResourceState<T> {
  const ResourceFailed(this.error);
  final Object error;
}
