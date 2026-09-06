# P5.2 entity-resolution benchmark

This is the versioned, offline P5.2 resolution gate. Its fixtures are synthetic
and production-like; they contain no customer or operator data and perform no
network, database, model, connector, or tool calls.

The v1 suite covers exact canonical names, aliases, Unicode and punctuation
normalization, duplicate names, alias collisions, fuzzy candidates, new
identities, retired records, entity-type separation, and tenant, actor, and
access-binding isolation. Candidate order is replayed in reverse for every case
to detect nondeterministic decisions.

Run `npm run check:p52-entity-resolution`. The gate requires 10,000 basis-point
auto-link precision and recall, review recall, and overall decision accuracy;
zero false auto-merges, scope leaks, or nondeterministic cases are allowed.
Fixture or scorer changes require a new suite/scorer version and explicit
review. Passing this bounded suite is regression evidence, not authorization to
merge an identity or broaden its access scope in production.
