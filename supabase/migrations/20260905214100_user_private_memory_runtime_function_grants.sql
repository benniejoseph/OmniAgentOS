GRANT EXECUTE ON FUNCTION
  public.omni_memory_access_grant_ids_v1_are_canonical(JSONB, INTEGER)
TO PUBLIC;
INSERT INTO public.omni_schema_version (
  version, name, checksum, applied_at
) VALUES (
  73,
  'user_private_memory_runtime_function_grants',
  'e48b32da855e7146ce7f3fb1448abe89efcb602f72cbe43509fd3f5ff3a8ae79',
  NOW()
);
