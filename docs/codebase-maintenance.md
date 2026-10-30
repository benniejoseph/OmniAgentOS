# Codebase maintenance

Asael's core is the personal work loop: Assistant and voice, governed tools and
specialist agents, Projects and knowledge, Follow-ups and watches, notifications,
Creative Studio and brand projects, and native Mac/Android clients. Self-improvement
uses the same reviewed execution and release boundaries.

## October 2026 cleanup

The cleanup removes disconnected implementation, not stored user records:

- Unreachable memory-authority/bootstrap/notice/data-right prototypes and their
  isolated tests. The active memory-access service, canonical actor checks and
  database policies remain.
- The unconnected outbound A2A adapter and AP2 credential/execution/reconciliation
  scaffolding. Local specialist delegation, inbound A2A, human-present payment
  review and scoped payment-history reads remain.
- Unreachable Flutter Builder/Missions screens, superseded wrapper widgets,
  unused resource helpers and Credential Broker v1 source tooling. Current
  project workspaces, navigation redirects and Credential Broker v2 remain.
- The retired eagle/raster/3D mascot implementation, assets and measurement
  tooling; unused starter artwork, dialogs, helper modules and CSS. Scout Lottie
  and its accessibility, reduced-motion and playback controls remain.
- Unsupported native API publications v45–v51 and the original v47 archive.
  Supported v52–v62 files retain their exact bytes and manifest digests.

The removed files are recoverable from Git revision
`8edad23796b31df72063ab9569ba4fe427a6f4b7`. Historical release notes describe their
original scope; the current contract registry and discovery endpoint determine
client support.

## Keep the repository small

Before adding a subsystem, identify its actual caller and the user outcome it
serves. Keep unconnected proposals in design notes instead of shipping speculative
stores, writers or worker APIs. Remove abandoned implementations and their
exclusive tests together once references and entry points are checked.

Import reachability is one signal. Next.js routes, native platform entry points,
generated contracts, command-line tools, test fixtures and public compatibility
boundaries have consumers outside an ordinary import graph. Retire supported
contracts only after installed-client evidence justifies changing the support
window. Never delete migrations or persisted records as a source cleanup shortcut.

Validate changed boundaries with focused regressions, compilation and the relevant
native analysis. Preserve release health, authentication, provenance and rollback
checks. Avoid repeating unrelated suites or retaining generated copies of retired
artifacts in the deployment.
