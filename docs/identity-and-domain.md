# Asael Identity and Domain Contract

`Asael` is the only product name. The canonical production origin is
`https://asael.bennierichard.com`; authentication callbacks, connector OAuth,
inbound MCP, worker traffic, metadata, mobile defaults, and release tooling use
that origin. The former Vercel production hostname only returns a permanent
redirect and is never an approved secret-bearing release target.

External OAuth clients must register both exact Asael callbacks:

- `https://asael.bennierichard.com/api/auth/google/callback`
- `https://asael.bennierichard.com/api/oauth/google/callback`

Webhook providers use
`https://asael.bennierichard.com/api/triggers/<trigger-id>/dispatch`; signed
POST requests must target the canonical URL directly rather than relying on a
redirect.

New identities are issued with Asael names:

- production browser cookie: `__Host-asael_session`;
- local browser cookie: `asael_session`;
- service API keys: `asael_sk_...`;
- MCP context resource: `asael://context`;
- browser/mobile preference and token keys: `asael.*` / `asael-*`.

Some old strings remain strictly as private compatibility contracts. They are
not product aliases and must not be shown as the application name:

- physical `omni_*` Postgres objects and immutable migration v1-v36 markers;
- deployed `OMNIAGENT_*` secret names and exact internal worker/browser hosts;
- cryptographic domains, signed payload types, and wire headers used to read or
  verify existing ciphertext, hashes, receipts, and connector sessions;
- installed mobile bundle IDs and desktop executable names.

Readers accept the compatible forms where continuity requires it, while new
writes use Asael identities. Removing a legacy reader requires evidence that
all corresponding sessions, keys, ciphertext, clients, receivers, and rollback
releases have been rotated. Physical database names may remain permanently;
renaming them provides no user benefit and would add a high-risk dual-write and
RLS migration.
