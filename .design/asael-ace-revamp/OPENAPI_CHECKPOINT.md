# Parked native OpenAPI candidate — 5 October 2026

The owner renewed UI revamp and ATLAS priority. This branch preserves the new-OpenAPI registration/first-import implementation for later resumption; it is not an accepted release. Do not start rediscovery or GitHub expansion while UI delivery is the active priority.

Base: accepted main72 `9f6c5d593d3dfb3f1f920f376b7209424e5a0bda`.
Branch: `codex/native-openapi-registration`.
Candidate identifiers: native45, migration242, app `1.23.29+65`.
The separate native UI follow-up reserves `1.23.30+66`; rebase this candidate onto the accepted UI revision and assign the next free app version/build before packaging it.

Implementation includes URL or pasted JSON/YAML preparation, bounded strict parsing, private scope-bound commitments and sealed snapshots, complete operation review, atomic disabled creation with pending contracts, exact recovery and abandonment, and expired-ready snapshot cleanup. The browser importer retains its existing behavior. API/store/SQL peer review found no remaining concrete source blocker after the recorded corrections.

Completed local checks:

- 41 parser/vault cases and 138 domain/API/maintenance cases passed.
- Draft native analysis passed. The earlier focused native run had 136 passes and one exact-target navigation failure; the corrected handoff then passed all 15 authority cases, including that unchanged assertion.
- Native publication was generated with v43/v44 retained byte-for-byte; candidate v42 retirement and v45 publication are recorded externally.
- Migration242 is registered with normalized checksum `69c0b615c0d7f966954c4c664d7dd1cd3110027ffd918381af6d11db9d92b495`. No database has applied it.

The redacted pre-commit secret scan reported 361 generic-key matches: 360 public `keySha256` fixture digests and the migration ledger checksum. These are deterministic fixture/ledger values, not credentials; resolving the scanner findings with narrow evidence remains pending. No global scanner rule was relaxed and no passing scan is claimed.

Pending before release: final changed-file checks, fresh database execution and schema verification, final native analysis after the handoff correction, a full release build, private package verification, exact-head hosted acceptance, merge and production release. The new 23-case serving-role integration file is authored but unrun. Candidate inventories of 266 tenant tables and 87 restrictive actor policies are expectations awaiting database verification.

Resume from this branch and the frozen wire/planning records in `/Volumes/Extreme Pro/Asael-release-records/2026-10-03-followups/ui-validation`. The root-owned disposable PostgreSQL runner is `/tmp/native-openapi-import-v45-postgres-check.py`; inspect it before use and keep heavy local commands serial. Preserve historical passing and failing logs instead of replacing them. This checkpoint has not migrated, deployed or installed anything.
