"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Code2,
  ExternalLink,
  FileCode2,
  Files,
  GitBranch,
  FolderGit2,
  Loader2,
  MonitorPlay,
  RotateCcw,
  Play,
  RefreshCw,
  Rocket,
  Save,
  Search,
  Send,
  ShieldCheck,
  SquareTerminal,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { buildAppBuilderAgentRequest } from "@/lib/app-builder/agent-request";
import {
  findAppBuilderSentinelReview,
  hasPassingAppBuilderSentinelReview,
} from "@/lib/app-builder/sentinel-review";
import styles from "./app-builder-studio.module.css";
import { BuilderClient, BuilderScopeChanged } from "./app-builder/client";
import { assertExactFile, assertSnapshotIdentity, boundedOutput, builderSelectionUrl, canConfirmRelease, exactSelection, isolatedPreviewUrl, readBuilderSelection, releaseConfirmationBasis, safeExternalUrl } from "./app-builder/state";
import { BuilderEvidence, BuilderOutcome, BuilderRecordChoices } from "./app-builder/components";

import type { BuildProject, BuilderSession, BuilderActivity, BuilderCheckpoint, BuilderBrowserEvidence, BuilderVerification, TreeEntry, BuilderFile, BuilderRepository, RepositoryBinding, RepositoryWorkspace, BuilderDelivery, BuilderDeployment, BuilderRelease, SessionPayload } from "./app-builder/model";

const commands = ["lint", "typecheck", "test", "build"] as const;

export type AppBuilderStudioProps = Readonly<{ project: BuildProject; ownerScopeKey: string; accessReady: boolean; canManage: boolean; active?: boolean; artifact?: { id: string; title: string } }>;
export function AppBuilderStudio(props: AppBuilderStudioProps) {
  return <AppBuilderContent key={JSON.stringify([props.ownerScopeKey, props.project.id])} {...props} />;
}
function AppBuilderContent({ project, ownerScopeKey, accessReady, canManage, active = true, artifact }: AppBuilderStudioProps) {
  const client = useMemo(() => new BuilderClient(), []);
  // Synchronous scope fence: an old callback cannot dispatch after the new props render.
  const lease = client.configure(Boolean(ownerScopeKey) && accessReady && active, canManage);
  const readJson = useCallback(<T,>(path: string, init: RequestInit = {}) => client.json<T>(path, init, lease), [client, lease]);
  const mutate = useCallback(<T = Record<string, unknown>,>(id: string, body: Record<string, unknown>, key = crypto.randomUUID()) => client.mutate<T>(id, body, key, lease), [client, lease]);
  const [, renderLifetime] = useState(0);
  useEffect(() => {
    // Strict Mode may dispose and restart this mount. Old leases remain invalid.
    const mountedLease = client.configure(Boolean(ownerScopeKey) && accessReady && active, canManage);
    if (mountedLease !== lease) renderLifetime((value) => value + 1);
    return () => { client.configure(false, false); };
    // Availability changes are fenced synchronously above; this effect owns disposal only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);
  const [initialSelection] = useState(() => readBuilderSelection(typeof window === "undefined" ? "" : window.location.search, project.id));
  const [selectedDeploymentId, setSelectedDeploymentId] = useState(initialSelection.deployment);
  const [selectedReleaseId, setSelectedReleaseId] = useState(initialSelection.release);
  const [selectedVerificationId, setSelectedVerificationId] = useState(initialSelection.verification);
  const [selectedFilePath, setSelectedFilePath] = useState(initialSelection.file);
  const [decisionGeneration, setDecisionGeneration] = useState(0);
  const [confirmationBasis, setConfirmationBasis] = useState("");
  const [snapshot, setSnapshotState] = useState<SessionPayload>({ session: null, activity: [], checkpoints: [], verifications: [], repositoryBinding: null, repositoryWorkspace: null, deliveries: [], deployments: [], releases: [], github: { configured: false, missing: [] }, vercel: { configured: false, missing: [] }, previewUrl: null });
  const snapshotRevisionRef = useRef(0);
  const setSnapshot = useCallback((next: SetStateAction<SessionPayload>) => {
    snapshotRevisionRef.current += 1;
    setSnapshotState(next);
  }, []);
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [file, setFile] = useState<BuilderFile>();
  const [fileSessionId, setFileSessionId] = useState<string>();
  const [draft, setDraft] = useState("");
  const [view, setView] = useState<"preview" | "code">(initialSelection.view);
  const [rail, setRail] = useState<"files" | "checkpoints" | "activity">(initialSelection.rail);
  const [prompt, setPrompt] = useState("");
  const [agentOutput, setAgentOutput] = useState("");
  const [sentinelOutput, setSentinelOutput] = useState("");
  const [commandOutput, setCommandOutput] = useState("");
  const [previewGeneration, setPreviewGeneration] = useState(0);
  const [fileSearch, setFileSearch] = useState("");
  const [githubOpen, setGithubOpen] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);
  const [repositories, setRepositories] = useState<BuilderRepository[]>([]);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState("");
  const [branchName, setBranchName] = useState("");
  const [deliveryTitle, setDeliveryTitle] = useState(`Build: ${project.title}`.slice(0, 180));
  const [deliveryBody, setDeliveryBody] = useState("");
  const [productionConfirmation, setProductionConfirmation] = useState("");
  const [busy, setBusy] = useState("loading");
  const [error, setError] = useState<string>();
  const [hasLoaded, setHasLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [sessionReadError, setSessionReadError] = useState<string>();
  const [treeRead, setTreeRead] = useState<{ loaded: boolean; loading: boolean; error?: string }>({ loaded: false, loading: false });
  const [fileRead, setFileRead] = useState<{ loading: boolean; path?: string; error?: string }>({ loading: false });
  const [repositoryRead, setRepositoryRead] = useState<{ loaded: boolean; loading: boolean; error?: string }>({ loaded: false, loading: false });
  const fileReadGeneration = useRef(0);
  const treeReadGeneration = useRef(0);
  const session = snapshot.session;
  const ready = session?.status === "ready" || session?.status === "running";
  const dirty = Boolean(file && draft !== file.content);
  const fileSessionMismatch = Boolean(file && session && fileSessionId !== session.id);
  const latestVerification = exactSelection(snapshot.verifications, selectedVerificationId);
  const deliveryVerification = snapshot.verifications.find((verification) =>
    verification.status === "passed" &&
    verification.checkpointId === session?.currentCheckpointId &&
    hasPassingAppBuilderSentinelReview(snapshot.activity, verification),
  );
  const latestSentinelReview = findAppBuilderSentinelReview(snapshot.activity, latestVerification);
  const currentCheckpoint = snapshot.checkpoints.find((checkpoint) => checkpoint.id === session?.currentCheckpointId);
  const latestDelivery = snapshot.deliveries[0];
  const latestDeployment = exactSelection(snapshot.deployments, selectedDeploymentId);
  const currentRelease = exactSelection(snapshot.releases, selectedReleaseId);
  const releaseMatchesDeployment = Boolean(currentRelease && currentRelease.deploymentId === latestDeployment?.id);
  const currentConfirmationBasis = releaseConfirmationBasis(session?.id || "", currentRelease);
  const confirmedRelease = productionConfirmation === "RELEASE" && confirmationBasis === currentConfirmationBasis;
  useEffect(() => {
    if (confirmationBasis && confirmationBasis !== currentConfirmationBasis) {
      setProductionConfirmation(""); setConfirmationBasis("");
    }
  }, [confirmationBasis, currentConfirmationBasis]);
  const [, renderExpiry] = useState(0);
  useEffect(() => {
    if (!active || !accessReady || !currentRelease || !["review_pending", "releasing"].includes(currentRelease.status)) return;
    const delay = Date.parse(currentRelease.expiresAt) - Date.now();
    if (!Number.isFinite(delay) || delay <= 0) return;
    const timer = window.setTimeout(() => renderExpiry((value) => value + 1), Math.min(delay + 1, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [active, accessReady, currentRelease]);
  const safePreview = isolatedPreviewUrl(snapshot.previewUrl, typeof window === "undefined" ? "" : window.location.origin);
  const actionBlocked = !canManage || project.status === "archived" || !ready || Boolean(sessionReadError) || client.outcome?.state === "uncertain";
  useEffect(() => {
    if (!active || !accessReady || !hasLoaded) return;
    if (!selectedDeploymentId && snapshot.deployments[0]) setSelectedDeploymentId(snapshot.deployments[0].id);
    if (!selectedReleaseId && snapshot.releases[0]) setSelectedReleaseId(snapshot.releases[0].id);
    if (!selectedVerificationId && snapshot.verifications[0]) setSelectedVerificationId(snapshot.verifications[0].id);
  }, [accessReady, active, hasLoaded, selectedDeploymentId, selectedReleaseId, selectedVerificationId, snapshot.deployments, snapshot.releases, snapshot.verifications]);
  useEffect(() => {
    if (!active || !accessReady || !hasLoaded) return;
    const next = builderSelectionUrl(window.location.href, { view, rail, file: selectedFilePath, deployment: selectedDeploymentId, release: selectedReleaseId, verification: selectedVerificationId }, project.id);
    window.history.replaceState(window.history.state, "", next);
  }, [accessReady, active, hasLoaded, view, rail, selectedFilePath, selectedDeploymentId, selectedReleaseId, selectedVerificationId, project.id]);
  const matchingDelivery = snapshot.deliveries.find((delivery) =>
    delivery.status === "pull_request_open" &&
    delivery.checkpointId === currentCheckpoint?.id &&
    delivery.verificationId === deliveryVerification?.id,
  );
  const repositoryWorkspaceCurrent = Boolean(
    snapshot.repositoryBinding && snapshot.repositoryWorkspace &&
    snapshot.repositoryBinding.repositoryId === snapshot.repositoryWorkspace.repositoryId &&
    snapshot.repositoryBinding.baseSha === snapshot.repositoryWorkspace.baseSha
  );

  const loadSession = useCallback(async () => {
    try {
      const payload = await readJson<SessionPayload>(`/api/projects/${encodeURIComponent(project.id)}/builder`);
      setSnapshot(assertSnapshotIdentity(payload, project.id));
      setHasLoaded(true);
      setSessionReadError(undefined);
      return payload;
    } catch (loadError) {
      if (loadError instanceof BuilderScopeChanged) throw loadError;
      setSessionReadError(message(loadError));
      throw loadError;
    }
  }, [project.id, setSnapshot, readJson]);

  const loadFile = useCallback(async (target: BuilderSession, path: string) => {
    const generation = ++fileReadGeneration.current;
    setFileRead({ loading: true, path });
    try {
      const payload = await readJson<{ file: BuilderFile }>(`/api/projects/${encodeURIComponent(project.id)}/builder?view=file&sessionId=${encodeURIComponent(target.id)}&path=${encodeURIComponent(path)}`);
      if (!client.current(lease) || generation !== fileReadGeneration.current) return;
      setFile(assertExactFile(payload.file, path));
      setSelectedFilePath(path);
      setFileSessionId(target.id);
      setDraft(payload.file.content);
      setFileRead({ loading: false, path });
    } catch (loadError) {
      if (loadError instanceof BuilderScopeChanged) return;
      if (!client.current(lease) || generation !== fileReadGeneration.current) return;
      setFileRead({ loading: false, path, error: message(loadError) });
      throw loadError;
    }
  }, [project.id, readJson, client, lease]);

  const loadTree = useCallback(async (target: BuilderSession, preferredPath?: string, retainOpenFile = false) => {
    const generation = ++treeReadGeneration.current;
    setTreeRead((current) => ({ ...current, loading: true }));
    let entries: TreeEntry[];
    try {
      const payload = await readJson<{ entries: TreeEntry[] }>(`/api/projects/${encodeURIComponent(project.id)}/builder?view=tree&sessionId=${encodeURIComponent(target.id)}`);
      if (!client.current(lease) || generation !== treeReadGeneration.current) return;
      entries = payload.entries;
      setTree(entries);
      setTreeRead({ loaded: true, loading: false });
    } catch (loadError) {
      if (loadError instanceof BuilderScopeChanged) return;
      if (!client.current(lease) || generation !== treeReadGeneration.current) return;
      setTreeRead((current) => ({ ...current, loading: false, error: message(loadError) }));
      throw loadError;
    }
    // Refreshing or clearing a file search must not replace the open draft.
    if (retainOpenFile && preferredPath) return;
    const paths = entries.filter((entry) => entry.kind === "file").map((entry) => entry.path);
    const nextPath = preferredPath || (paths.includes("app/page.tsx") ? "app/page.tsx" : paths[0]);
    if (nextPath) await loadFile(target, nextPath);
  }, [loadFile, project.id, readJson, client, lease]);

  const searchTree = useCallback(async (target: BuilderSession, query: string) => {
    const normalized = query.trim();
    if (!normalized) return loadTree(target, file?.path, true);
    const generation = ++treeReadGeneration.current;
    setTreeRead((current) => ({ ...current, loading: true }));
    try {
      const payload = await readJson<{ entries: TreeEntry[] }>(`/api/projects/${encodeURIComponent(project.id)}/builder?view=search&sessionId=${encodeURIComponent(target.id)}&query=${encodeURIComponent(normalized)}`);
      if (!client.current(lease) || generation !== treeReadGeneration.current) return;
      setTree(payload.entries);
      setTreeRead({ loaded: true, loading: false });
    } catch (loadError) {
      if (loadError instanceof BuilderScopeChanged) return;
      if (!client.current(lease) || generation !== treeReadGeneration.current) return;
      setTreeRead((current) => ({ ...current, loading: false, error: message(loadError) }));
      throw loadError;
    }
  }, [file?.path, loadTree, project.id, readJson, client, lease]);

  const loadRepositories = useCallback(async () => {
    setRepositoryRead((current) => ({ ...current, loading: true }));
    try {
      const payload = await readJson<{ repositories: BuilderRepository[] }>(`/api/projects/${encodeURIComponent(project.id)}/builder?view=github.repositories`);
      setRepositories(payload.repositories);
      setSelectedRepositoryId((current) => current || snapshot.repositoryBinding?.repositoryId || payload.repositories[0]?.repositoryId || "");
      setRepositoryRead({ loaded: true, loading: false });
      return payload.repositories;
    } catch (loadError) {
      if (loadError instanceof BuilderScopeChanged) return;
      setRepositoryRead((current) => ({ ...current, loading: false, error: message(loadError) }));
      throw loadError;
    }
  }, [project.id, snapshot.repositoryBinding?.repositoryId, readJson]);

  useEffect(() => {
    if (!accessReady || !active || !ownerScopeKey) return;
    let current = true;
    setSessionReadError("Checking current workspace access…");
    setProductionConfirmation(""); setConfirmationBasis("");
    setRefreshing(false);
    setFileRead((value) => ({ ...value, loading: false }));
    setRepositoryRead((value) => ({ ...value, loading: false }));
    async function initialize() {
      let sessionLoaded = false;
      try {
        const payload = await readJson<SessionPayload>(`/api/projects/${encodeURIComponent(project.id)}/builder`);
        if (!current) return;
        setSnapshot(assertSnapshotIdentity(payload, project.id));
        sessionLoaded = true;
        setHasLoaded(true);
        setSessionReadError(undefined);
        if (payload.session && (payload.session.status === "ready" || payload.session.status === "running")) {
          await loadTree(payload.session, selectedFilePath || undefined, Boolean(file));
        }
      } catch (loadError) {
        if (loadError instanceof BuilderScopeChanged) return;
        if (current) {
          setError(message(loadError));
          if (!sessionLoaded) setSessionReadError(message(loadError));
        }
      } finally {
        if (current) setBusy("");
      }
    }
    void initialize();
    return () => { current = false; };
  // File selection is deliberately captured only when the access lease changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessReady, active, ownerScopeKey, loadTree, project.id, setSnapshot, readJson]);

  useEffect(() => {
    if (
      !accessReady || !active || !canManage || busy || client.outcome?.state === "uncertain" || !session || !latestDeployment ||
      !new Set<BuilderDeployment["status"]>(["queued", "building", "verifying"]).has(latestDeployment.status)
    ) return;
    let current = true;
    const timer = window.setTimeout(async () => {
      try {
        const payload = await mutate<{ deployment: BuilderDeployment }>(project.id, {
          action: "deployment.refresh",
          sessionId: session.id,
          deploymentId: latestDeployment.id,
        });
        if (!current) return;
        setSnapshot((current) => ({
          ...current,
          deployments: [payload.deployment, ...current.deployments.filter((item) => item.id !== payload.deployment.id)].slice(0, 20),
        }));
      } catch (refreshError) {
        if (refreshError instanceof BuilderScopeChanged) return;
        if (current) setError(message(refreshError));
      }
    }, 4_500);
    return () => { current = false; window.clearTimeout(timer); };
  }, [latestDeployment, project.id, session, setSnapshot, accessReady, active, canManage, busy, client, mutate, decisionGeneration]);

  useEffect(() => {
    if (!accessReady || !active || !canManage || busy || client.outcome?.state === "uncertain" || !session || !currentRelease?.providerDeploymentId || !new Set<BuilderRelease["status"]>(["releasing", "building"]).has(currentRelease.status)) return;
    let current = true;
    const timer = window.setTimeout(async () => {
      try {
        const payload = await mutate<{ release: BuilderRelease }>(project.id, {
          action: "release.refresh",
          sessionId: session.id,
          releaseId: currentRelease.id,
        });
        if (!current) return;
        setSnapshot((current) => ({
          ...current,
          releases: [payload.release, ...current.releases.filter((item) => item.id !== payload.release.id)].slice(0, 20),
        }));
      } catch (refreshError) {
        if (refreshError instanceof BuilderScopeChanged) return;
        if (current) setError(message(refreshError));
      }
    }, 4_500);
    return () => { current = false; window.clearTimeout(timer); };
  }, [currentRelease, project.id, session, setSnapshot, accessReady, active, canManage, busy, client, mutate, decisionGeneration]);

  async function createWorkspace() {
    setBusy("create");
    setError(undefined);
    try {
      const payload = await mutate<SessionPayload & { created: boolean }>(project.id, { action: "create" }, `builder-create:${project.id}`);
      setSnapshot((current) => ({ ...current, ...payload }));
      if (payload.session) await loadTree(payload.session);
    } catch (createError) {
      if (createError instanceof BuilderScopeChanged) return;
      setError(message(createError));
    } finally {
      if (client.current(lease)) setBusy("");
    }
  }

  async function saveFile() {
    if (!session || !file || !dirty || fileSessionMismatch || actionBlocked) return;
    setBusy("save");
    setError(undefined);
    try {
      await mutate(project.id, { action: "file.update", sessionId: session.id, path: file.path, expectedSha256: file.sha256, content: draft });
      await loadFile(session, file.path);
      await loadSession();
    } catch (saveError) {
      if (saveError instanceof BuilderScopeChanged) return;
      setError(message(saveError));
    } finally {
      if (client.current(lease)) setBusy("");
    }
  }

  async function deleteFile() {
    if (!session || !file || dirty || fileSessionMismatch || actionBlocked) return;
    if (!window.confirm(`Delete ${file.path} from this workspace? The deletion stays reviewable before GitHub delivery.`)) return;
    setBusy("delete");
    setError(undefined);
    try {
      await mutate(project.id, { action: "file.delete", sessionId: session.id, path: file.path, expectedSha256: file.sha256 });
      setFile(undefined);
      setSelectedFilePath("");
      setDraft("");
      await loadTree(session);
      await loadSession();
    } catch (deleteError) {
      if (deleteError instanceof BuilderScopeChanged) return;
      setError(message(deleteError));
    } finally {
      if (client.current(lease)) setBusy("");
    }
  }

  async function createCheckpoint(
    target: BuilderSession,
    reason: "manual" | "before_forge" | "after_forge" | "before_sentinel",
    label: string,
    sourceRunId?: string,
  ) {
    const payload = await mutate<SessionPayload & { checkpoint: BuilderCheckpoint }>(project.id, {
      action: "checkpoint.create",
      sessionId: target.id,
      expectedSessionRevision: target.revision,
      reason,
      label,
      ...(sourceRunId ? { sourceRunId } : {}),
    });
    setSnapshot((current) => ({ ...current, ...payload }));
    return payload;
  }

  async function saveCheckpoint() {
    if (!session || dirty || actionBlocked) return;
    setBusy("checkpoint");
    setError(undefined);
    try {
      await createCheckpoint(session, "manual", `Saved revision ${session.revision}`);
      setRail("checkpoints");
    } catch (checkpointError) {
      if (checkpointError instanceof BuilderScopeChanged) return;
      setError(message(checkpointError));
    } finally {
      if (client.current(lease)) setBusy("");
    }
  }

  async function restoreCheckpoint(checkpoint: BuilderCheckpoint) {
    if (!session || dirty || actionBlocked || session.currentCheckpointId === checkpoint.id || Boolean(checkpoint.expiresAt && Date.parse(checkpoint.expiresAt) <= Date.now())) return;
    if (!window.confirm(`Restore checkpoint ${checkpoint.id} (“${checkpoint.label}”) in sandbox ${session.id}? Asael will save the current workspace first.`)) return;
    setBusy(`restore:${checkpoint.id}`);
    setError(undefined);
    try {
      const payload = await mutate<SessionPayload & { restored: boolean }>(project.id, {
        action: "checkpoint.restore",
        sessionId: session.id,
        checkpointId: checkpoint.id,
        expectedSessionRevision: session.revision,
      });
      setSnapshot((current) => ({ ...current, ...payload }));
      if (payload.session) await loadTree(payload.session, file?.path);
      setView("preview");
    } catch (restoreError) {
      if (restoreError instanceof BuilderScopeChanged) return;
      setError(message(restoreError));
    } finally {
      if (client.current(lease)) setBusy("");
    }
  }

  async function runCommand(command: typeof commands[number] | "start_preview") {
    if (!session || actionBlocked || dirty) return;
    setBusy(command);
    setError(undefined);
    setCommandOutput("");
    try {
      const payload = await mutate<{ result: { exitCode: number; stdout: string; stderr: string; durationMs: number } }>(project.id, { action: "command.run", sessionId: session.id, command });
      setCommandOutput(boundedOutput([payload.result.stdout, payload.result.stderr].filter(Boolean).join("\n") || `${command} completed with exit code ${payload.result.exitCode}.`));
      await loadSession();
      if (command === "start_preview") {
        setPreviewGeneration((generation) => generation + 1);
        setView("preview");
      }
    } catch (commandError) {
      if (commandError instanceof BuilderScopeChanged) return;
      setError(message(commandError));
    } finally {
      if (client.current(lease)) setBusy("");
    }
  }

  async function askForge(event: React.FormEvent) {
    event.preventDefault();
    const request = prompt.trim();
    if (!request || !session || dirty || actionBlocked) return;
    setBusy("forge");
    setAgentOutput("");
    setError(undefined);
    try {
      const sealed = await createCheckpoint(session, "before_forge", `Before Forge · ${request.slice(0, 90)}`);
      if (!sealed.session) throw new Error("The recovery checkpoint did not return an active session.");
      const agentRequest = buildAppBuilderAgentRequest({
          projectId: project.id,
          message: `Work only in App Builder session ${session.id} for project ${project.id}. Inspect files before editing and preserve SHA-256 fences. Use bounded file-read ranges, starting with the smallest relevant section, and continue only when needed. User request: ${request}. Run focused checks and restart the preview when complete.`,
          requestId: crypto.randomUUID(),
          agentId: "forge",
        });
      let accumulated = "";
      let runId = "";
      let completed = false;
      await client.agent(agentRequest, lease, (agentEvent) => {
        if (agentEvent.type === "run" && agentEvent.runId) runId = agentEvent.runId;
        if (agentEvent.type === "delta" && agentEvent.text) accumulated += agentEvent.text;
        if (agentEvent.type === "done") {
          completed = true;
          if (agentEvent.response) accumulated = agentEvent.response;
        }
        if (agentEvent.type === "status" && !accumulated) accumulated = [agentEvent.label, agentEvent.detail].filter(Boolean).join(" — ");
        if (agentEvent.type === "tool") accumulated += `\n${agentEvent.toolName || "Tool"}: ${agentEvent.status || "working"}`;
        if (agentEvent.type === "waiting_approval") accumulated += `\n${agentEvent.message || "Forge is waiting for approval in Command."}`;
        if (agentEvent.type === "error") throw new Error(agentEvent.message || "Forge stopped unexpectedly.");
        accumulated = boundedOutput(accumulated);
        setAgentOutput(accumulated.trim());
      });
      if (!completed || !runId) throw new Error("Forge did not return a completed run. Inspect Command before starting another request.");
      setPrompt("");
      const refreshed = await loadSession();
      let finalSnapshot = refreshed;
      if (completed && runId && refreshed.session) {
        finalSnapshot = await createCheckpoint(refreshed.session, "after_forge", `Forge result · ${request.slice(0, 88)}`, runId);
      }
      if (finalSnapshot.session) await loadTree(finalSnapshot.session, file?.path);
    } catch (agentError) {
      if (agentError instanceof BuilderScopeChanged) return;
      setError(message(agentError));
    } finally {
      if (client.current(lease)) setBusy("");
    }
  }

  async function verifyWithSentinel() {
    if (!session || dirty || actionBlocked) return;
    setBusy("sentinel");
    setSentinelOutput("");
    setError(undefined);
    try {
      const sealed = await createCheckpoint(session, "before_sentinel", `Sentinel review · revision ${session.revision}`);
      if (!sealed.session) throw new Error("Sentinel could not seal the workspace revision.");
      const verificationPayload = await mutate<{ verification: BuilderVerification }>(project.id, {
        action: "verification.run",
        sessionId: sealed.session.id,
        checkpointId: sealed.checkpoint.id,
        expectedSessionRevision: sealed.session.revision,
      });
      const verification = verificationPayload.verification;
      setSelectedVerificationId(verification.id);
      setSnapshot((current) => ({ ...current, verifications: [verification, ...current.verifications.filter((item) => item.id !== verification.id)].slice(0, 10) }));
      const agentRequest = buildAppBuilderAgentRequest({
          projectId: project.id,
          message: `Independently review App Builder verification ${verification.id} at checkpoint ${verification.checkpointId} in session ${sealed.session.id}. Use the governed verification receipt and inspect the project files. Project objective: ${project.objective}. Deterministic evidence: ${JSON.stringify(verification)}. Return a concise PASS or BLOCK verdict, specific evidence, and the smallest corrective actions. The browserEvidence field is retired legacy history; do not use it as readiness evidence or claim to have visually inspected the app.`,
          requestId: crypto.randomUUID(),
          agentId: "sentinel",
        });
      let accumulated = "";
      let runId = "";
      let completed = false;
      await client.agent(agentRequest, lease, (agentEvent) => {
        if (agentEvent.type === "run" && agentEvent.runId) runId = agentEvent.runId;
        if (agentEvent.type === "delta" && agentEvent.text) accumulated += agentEvent.text;
        if (agentEvent.type === "done") {
          completed = true;
          if (agentEvent.response) accumulated = agentEvent.response;
        }
        if (agentEvent.type === "status" && !accumulated) accumulated = [agentEvent.label, agentEvent.detail].filter(Boolean).join(" — ");
        if (agentEvent.type === "tool") accumulated += `\n${agentEvent.toolName || "Tool"}: ${agentEvent.status || "working"}`;
        if (agentEvent.type === "error") throw new Error(agentEvent.message || "Sentinel stopped unexpectedly.");
        accumulated = boundedOutput(accumulated);
        setSentinelOutput(accumulated.trim());
      });
      if (!completed || !runId) throw new Error("Sentinel did not produce a completed review receipt.");
      const review = await mutate<{ sentinel: { runId: string; status: string; verdict: "passed" | "blocked" } }>(project.id, {
        action: "sentinel.record",
        sessionId: sealed.session.id,
        verificationId: verification.id,
        sourceRunId: runId,
      });
      await loadSession();
      if (review.sentinel.verdict !== "passed") {
        throw new Error("Sentinel blocked this revision. Resolve the verdict before GitHub or Vercel delivery.");
      }
    } catch (verificationError) {
      if (verificationError instanceof BuilderScopeChanged) return;
      setError(message(verificationError));
    } finally {
      if (client.current(lease)) setBusy("");
    }
  }

  async function toggleGithub() {
    const next = !githubOpen;
    setGithubOpen(next);
    setError(undefined);
    if (!next || !snapshot.github.configured || repositories.length) return;
    setBusy("github.repositories");
    try {
      await loadRepositories();
    } catch (repositoryError) {
      if (repositoryError instanceof BuilderScopeChanged) return;
      setError(message(repositoryError));
    } finally {
      if (client.current(lease)) setBusy("");
    }
  }

  async function bindRepository() {
    if (!session || !repositories.some((row) => row.repositoryId === selectedRepositoryId) || repositoryRead.error) return;
    setBusy("github.bind");
    setError(undefined);
    try {
      const payload = await mutate<{ repositoryBinding: RepositoryBinding }>(project.id, {
        action: "repository.bind",
        sessionId: session.id,
        repositoryId: selectedRepositoryId,
      });
      setSnapshot((current) => ({ ...current, repositoryBinding: payload.repositoryBinding }));
      setBranchName(suggestBranch(project.title, currentCheckpoint?.workspaceSha256));
      await loadSession();
    } catch (bindingError) {
      if (bindingError instanceof BuilderScopeChanged) return;
      setError(message(bindingError));
    } finally {
      if (client.current(lease)) setBusy("");
    }
  }

  async function checkoutRepository() {
    const binding = snapshot.repositoryBinding;
    if (!session || !binding || dirty || actionBlocked) return;
    const action = snapshot.repositoryWorkspace ? "replace the current repository workspace" : "replace the starter workspace";
    if (!window.confirm(`Open ${binding.repositoryFullName} at ${binding.baseSha}? This will ${action}; Asael seals a recovery checkpoint first.`)) return;
    setBusy("github.checkout");
    setError(undefined);
    try {
      const payload = await mutate<{
        session: BuilderSession;
        repositoryWorkspace: RepositoryWorkspace;
        previewUrl: string;
      }>(project.id, {
        action: "repository.checkout",
        sessionId: session.id,
        repositoryBindingId: binding.id,
        expectedBindingRevision: binding.revision,
        expectedSessionRevision: session.revision,
      });
      setSnapshot((current) => ({ ...current, session: payload.session, repositoryWorkspace: payload.repositoryWorkspace, previewUrl: payload.previewUrl }));
      setFileSearch("");
      setFile(undefined);
      setSelectedFilePath("");
      setDraft("");
      const refreshed = await loadSession();
      if (refreshed.session) await loadTree(refreshed.session);
    } catch (checkoutError) {
      if (checkoutError instanceof BuilderScopeChanged) return;
      setError(message(checkoutError));
      await loadSession().catch(() => undefined);
    } finally {
      if (client.current(lease)) setBusy("");
    }
  }

  async function refreshRepositories() {
    setBusy("github.repositories");
    setError(undefined);
    try {
      await loadRepositories();
    } catch (repositoryError) {
      if (repositoryError instanceof BuilderScopeChanged) return;
      setError(message(repositoryError));
    } finally {
      if (client.current(lease)) setBusy("");
    }
  }

  async function createPullRequest() {
    const binding = snapshot.repositoryBinding;
    if (!session || !binding || !currentCheckpoint || !deliveryVerification || dirty || actionBlocked) return;
    setBusy("github.deliver");
    setError(undefined);
    try {
      const payload = await mutate<{ delivery: BuilderDelivery }>(project.id, {
        action: "delivery.create",
        sessionId: session.id,
        repositoryBindingId: binding.id,
        expectedBindingRevision: binding.revision,
        checkpointId: currentCheckpoint.id,
        verificationId: deliveryVerification.id,
        branchName: branchName || suggestBranch(project.title, currentCheckpoint.workspaceSha256),
        title: deliveryTitle.trim(),
        body: deliveryBody.trim(),
        draft: true,
      });
      setSnapshot((current) => ({
        ...current,
        deliveries: [payload.delivery, ...current.deliveries.filter((item) => item.id !== payload.delivery.id)].slice(0, 20),
      }));
      await loadSession();
    } catch (deliveryError) {
      if (deliveryError instanceof BuilderScopeChanged) return;
      setError(message(deliveryError));
      await loadSession().catch(() => undefined);
    } finally {
      if (client.current(lease)) setBusy("");
    }
  }

  function toggleDeploy() {
    setDeployOpen((current) => !current);
    setGithubOpen(false);
    setError(undefined);
  }

  async function createPreviewDeployment() {
    if (!session || !currentCheckpoint || !deliveryVerification || dirty || actionBlocked) return;
    setBusy("vercel.deploy");
    setError(undefined);
    setDeployOpen(true);
    try {
      const payload = await mutate<{ deployment: BuilderDeployment }>(project.id, {
        action: "deployment.preview",
        sessionId: session.id,
        checkpointId: currentCheckpoint.id,
        verificationId: deliveryVerification.id,
        ...(matchingDelivery ? { repositoryDeliveryId: matchingDelivery.id } : {}),
      });
      setSnapshot((current) => ({
        ...current,
        deployments: [payload.deployment, ...current.deployments.filter((item) => item.id !== payload.deployment.id)].slice(0, 20),
      }));
      setSelectedDeploymentId(payload.deployment.id);
      await loadSession();
    } catch (deploymentError) {
      if (deploymentError instanceof BuilderScopeChanged) return;
      setError(message(deploymentError));
      await loadSession().catch(() => undefined);
    } finally {
      if (client.current(lease)) setBusy("");
    }
  }

  async function refreshPreviewDeployment(deployment: BuilderDeployment) {
    if (!session) return;
    setBusy(`vercel.refresh:${deployment.id}`);
    setError(undefined);
    try {
      const payload = await mutate<{ deployment: BuilderDeployment }>(project.id, {
        action: "deployment.refresh",
        sessionId: session.id,
        deploymentId: deployment.id,
      });
      setSnapshot((current) => ({
        ...current,
        deployments: [payload.deployment, ...current.deployments.filter((item) => item.id !== payload.deployment.id)].slice(0, 20),
      }));
      await loadSession();
    } catch (refreshError) {
      if (refreshError instanceof BuilderScopeChanged) return;
      setError(message(refreshError));
    } finally {
      if (client.current(lease)) setBusy("");
    }
  }

  async function prepareProductionReview() {
    if (!session || !latestDeployment || latestDeployment.status !== "ready" || dirty || actionBlocked) return;
    setBusy("release.review");
    setError(undefined);
    setProductionConfirmation("");
    try {
      const payload = await mutate<{ release: BuilderRelease }>(project.id, {
        action: "release.preview",
        sessionId: session.id,
        deploymentId: latestDeployment.id,
      });
      setSnapshot((current) => ({
        ...current,
        releases: [payload.release, ...current.releases.filter((item) => item.id !== payload.release.id)].slice(0, 20),
      }));
      setSelectedReleaseId(payload.release.id);
      await loadSession();
    } catch (reviewError) {
      if (reviewError instanceof BuilderScopeChanged) return;
      setError(message(reviewError));
    } finally {
      if (client.current(lease)) setBusy("");
    }
  }

  async function releaseProduction(release: BuilderRelease) {
    if (!session || actionBlocked || !confirmedRelease || !releaseMatchesDeployment || !canConfirmRelease(release, Date.now())) return;
    if (!window.confirm(`Release ${release.id} with digest ${release.releaseDigest} from preview ${release.deploymentId} to production?`)) return;
    setBusy("release.production");
    setError(undefined);
    try {
      const payload = await mutate<{ release: BuilderRelease }>(project.id, {
        action: "release.production",
        sessionId: session.id,
        releaseId: release.id,
        releaseDigest: release.releaseDigest,
        confirmation: "RELEASE",
      });
      setSnapshot((current) => ({
        ...current,
        releases: [payload.release, ...current.releases.filter((item) => item.id !== payload.release.id)].slice(0, 20),
      }));
      setProductionConfirmation("");
      await loadSession();
    } catch (releaseError) {
      if (releaseError instanceof BuilderScopeChanged) return;
      setError(message(releaseError));
      await loadSession().catch(() => undefined);
    } finally {
      if (client.current(lease)) setBusy("");
    }
  }

  async function refreshProductionRelease(release: BuilderRelease) {
    if (!session) return;
    setBusy(`release.refresh:${release.id}`);
    setError(undefined);
    try {
      const payload = await mutate<{ release: BuilderRelease }>(project.id, {
        action: "release.refresh",
        sessionId: session.id,
        releaseId: release.id,
      });
      setSnapshot((current) => ({
        ...current,
        releases: [payload.release, ...current.releases.filter((item) => item.id !== payload.release.id)].slice(0, 20),
      }));
      await loadSession();
    } catch (refreshError) {
      if (refreshError instanceof BuilderScopeChanged) return;
      setError(message(refreshError));
    } finally {
      if (client.current(lease)) setBusy("");
    }
  }

  async function stopWorkspace() {
    if (!session || !ready || dirty || actionBlocked) return;
    if (!window.confirm(`Stop sandbox ${session.id}? Running work and the live preview will stop. Recorded checkpoints and evidence remain available.`)) return;
    setBusy("stop"); setError(undefined);
    try { await mutate(project.id, { action: "stop", sessionId: session.id }); await loadSession(); }
    catch (stopError) { if (!(stopError instanceof BuilderScopeChanged)) setError(message(stopError)); }
    finally { if (client.current(lease)) setBusy(""); }
  }

  const files = useMemo(() => tree.filter((entry) => entry.kind === "file"), [tree]);

  async function refreshStudio() {
    if (busy || refreshing) return;
    const revision = snapshotRevisionRef.current;
    setRefreshing(true);
    setBusy("refresh");
    try {
      let payload: SessionPayload;
      try {
        payload = await readJson<SessionPayload>(`/api/projects/${encodeURIComponent(project.id)}/builder`);
      } catch (loadError) {
        if (loadError instanceof BuilderScopeChanged) return;
        if (revision !== snapshotRevisionRef.current) return;
        setSessionReadError(message(loadError));
        throw loadError;
      }
      // Provider receipts can arrive while this read is pending. A superseded
      // refresh must replace neither that snapshot nor its source-file tree.
      if (revision !== snapshotRevisionRef.current) return;
      setSnapshot(assertSnapshotIdentity(payload, project.id));
      setHasLoaded(true);
      setSessionReadError(undefined);
      if (payload.session && ["ready", "running"].includes(payload.session.status)) {
        await loadTree(payload.session, file?.path || selectedFilePath || undefined, Boolean(file));
      }
      client.acknowledgeRefreshedOutcome();
      setError(undefined);
    } catch (loadError) {
      if (loadError instanceof BuilderScopeChanged) return;
      setSessionReadError(message(loadError));
      setError(message(loadError));
    } finally {
      if (client.current(lease)) { setRefreshing(false); setBusy(""); }
    }
  }

  if (!active && !hasLoaded) return null;
  if (!accessReady || !ownerScopeKey) return <section className={styles.empty} role="status">Build studio is unavailable while workspace access is being checked.</section>;
  if (busy === "loading") return <section className={styles.loading} role="status"><span>Loading Build studio…</span><div aria-hidden="true"><i /><i /><i /></div></section>;

  if (!hasLoaded) return <section className={styles.empty} aria-labelledby="builder-unavailable-title"><AlertCircle aria-hidden="true" size={24} /><h3 id="builder-unavailable-title">Build studio unavailable</h3><p>The workspace could not be loaded. Retry to check its current state.</p>{error ? <p className={styles.error} role="alert">{error}</p> : null}<button type="button" onClick={() => void refreshStudio()} disabled={refreshing}>{refreshing ? "Loading…" : "Retry Build studio"}</button></section>;

  if (!session) return (
    <section className={styles.empty}>
      <div className={styles.emptyMark}><WandSparkles aria-hidden="true" size={28} /></div>
      <h3>Build workspace</h3>
      <span>Create an isolated workspace for this project, then edit files, preview the app, and review verified changes before delivery.</span>
      <div className={styles.guardrails}><span><ShieldCheck aria-hidden="true" size={14} /> Project-scoped</span><span><Code2 aria-hidden="true" size={14} /> TypeScript starter</span><span><MonitorPlay aria-hidden="true" size={14} /> Private preview</span></div>
      <BuilderOutcome outcome={client.outcome} refreshFailed={Boolean(sessionReadError || treeRead.error)} reviewed={client.canMakeNewDecision()} onReview={() => { client.allowNewDecision(); setDecisionGeneration((value) => value + 1); }} />
      <button type="button" onClick={() => void refreshStudio()} disabled={Boolean(busy)}>Refresh workspace state</button>
      <button type="button" onClick={() => void createWorkspace()} disabled={Boolean(busy) || !canManage || project.status === "archived" || client.outcome?.state === "uncertain"}>{busy === "create" ? <Loader2 className={styles.spinner} size={15} /> : <Play aria-hidden="true" size={15} />} Create build workspace</button>
      {project.status === "archived" ? <p className={styles.help}>Reopen the project before creating a build workspace.</p> : null}
      {error ? <p className={styles.error} role="alert"><AlertCircle aria-hidden="true" size={14} /> {error}</p> : null}
    </section>
  );


  return (
    <section hidden={!active} inert={!active} className={styles.studio} data-testid="app-builder-studio" aria-label="Build studio" aria-busy={Boolean(busy) || refreshing}>
      <div className={styles.buildContext}><span>Work / Build</span><h2>{project.title}</h2><p>Project <code>{project.id}</code>{artifact ? <> · Selected artifact <code>{artifact.id}</code> · {artifact.title}</> : null}</p></div>
      <header className={styles.studioHeader}>
        <div><Code2 aria-hidden="true" size={20} /><div><h3>Build studio</h3><small>{repositoryWorkspaceCurrent && snapshot.repositoryWorkspace ? `${snapshot.repositoryWorkspace.repositoryFullName} · ${snapshot.repositoryWorkspace.baseSha}` : session.templateId} · revision {session.revision}</small><small>Workspace {session.status} · recorded update {new Date(session.updatedAt).toLocaleString()}</small></div></div>
        <div className={styles.headerActions}>
          <button type="button" onClick={() => void refreshStudio()} disabled={Boolean(busy) || refreshing}><RefreshCw aria-hidden="true" size={16} /> {refreshing ? "Refreshing…" : "Refresh snapshot"}</button>
          <button type="button" onClick={() => void stopWorkspace()} disabled={Boolean(busy) || dirty || actionBlocked}>Stop sandbox</button>
          <button type="button" onClick={() => void saveCheckpoint()} disabled={Boolean(busy) || dirty || actionBlocked} title={dirty ? "Save the open file before sealing a checkpoint" : "Save a recoverable checkpoint"}><Save aria-hidden="true" size={14} /> Checkpoint</button>
          <button type="button" onClick={() => void runCommand("start_preview")} disabled={Boolean(busy) || actionBlocked || dirty} title="Restart preview" aria-label="Restart live preview"><RefreshCw aria-hidden="true" size={14} className={busy === "start_preview" ? styles.spinner : undefined} /> Restart preview</button>
          {active && ready && safePreview ? <a href={safePreview} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" size={14} /> Open preview</a> : null}
          <button type="button" onClick={() => { setDeployOpen(false); void toggleGithub(); }} aria-expanded={githubOpen} aria-controls="builder-github-delivery" disabled={Boolean(busy) && busy !== "github.repositories"} title="Review and deliver this build through the private GitHub App"><GitBranch aria-hidden="true" size={14} /> GitHub</button>
          <button type="button" onClick={toggleDeploy} aria-expanded={deployOpen} aria-controls="builder-preview-delivery" disabled={Boolean(busy)} title="Create and verify a revision-bound Vercel preview"><Rocket aria-hidden="true" size={14} /> Deploy</button>
        </div>
      </header>

      {!ready ? <p className={styles.readNotice} role="status">Sandbox {session.status}. {session.lastErrorCode || "Recorded checkpoints, activity and delivery evidence remain available. Refresh to check its current state."}</p> : null}
      {!canManage ? <p className={styles.readNotice}>Your role can inspect this workspace. Builder actions require execute.tool permission.</p> : null}
      <BuilderOutcome outcome={client.outcome} refreshFailed={Boolean(sessionReadError || fileRead.error || treeRead.error)} reviewed={client.canMakeNewDecision()} onReview={() => { client.allowNewDecision(); setDecisionGeneration((value) => value + 1); }} />
      <BuilderRecordChoices snapshot={snapshot} deploymentId={selectedDeploymentId} releaseId={selectedReleaseId} verificationId={selectedVerificationId} chooseDeployment={(id) => { setSelectedDeploymentId(id); setProductionConfirmation(""); }} chooseRelease={(id) => { setSelectedReleaseId(id); setProductionConfirmation(""); }} chooseVerification={setSelectedVerificationId} />
      <BuilderEvidence session={session} deployment={latestDeployment} release={currentRelease} verification={latestVerification} />
      {error ? <div className={styles.errorBanner} role="alert"><AlertCircle aria-hidden="true" size={15} /><span>{error}</span><button type="button" onClick={() => setError(undefined)}>Dismiss</button></div> : null}

      {sessionReadError ? <p className={styles.readNotice}>The snapshot could not be refreshed. The last loaded workspace and your drafts are retained.</p> : null}
      {fileSessionMismatch ? <p id="builder-session-change" className={styles.readNotice} role="status">The workspace session changed. The retained file and draft belong to session <code>{fileSessionId || "unavailable"}</code>, not the current session <code>{session.id}</code>. Copy any unsaved text before opening a file from the current session. Editing, saving, and deleting the retained file are unavailable.</p> : null}
      {refreshing ? <p className={styles.help} role="status">Refreshing the workspace snapshot…</p> : null}
      {dirty ? <p className={styles.unsaved} role="status">Unsaved changes in <code>{file?.path}</code>. Save the file before creating a checkpoint, running checks, or requesting Agent work.</p> : null}
      {busy ? <p className={styles.help} role="status">In progress: {eventLabel(busy)}.</p> : null}

      {githubOpen ? <section id="builder-github-delivery" className={styles.deliveryPanel} aria-label="GitHub delivery">
        <header><div><span className={styles.deliveryKicker}>Source handoff</span><h3>Open a reviewable pull request</h3><p>Asael writes only to a new branch in one repository selected for the private GitHub App.</p></div><div className={styles.deliveryState} data-ready={snapshot.github.configured || undefined}><i />{snapshot.github.configured ? "GitHub App ready" : "Setup required"}</div></header>
        {!snapshot.github.configured ? <div className={styles.githubSetup}><AlertCircle aria-hidden="true" size={18} /><div><strong>Complete the private GitHub App connection</strong><p>Missing: {snapshot.github.missing.join(", ") || "application credentials"}. Grant selected-repository access with Contents and Pull requests write plus Checks read. Asael mints a short-lived token for the selected repository only.</p>{safeExternalUrl(snapshot.github.installUrl) ? <a href={safeExternalUrl(snapshot.github.installUrl)} target="_blank" rel="noopener noreferrer">Install the GitHub App <ExternalLink aria-hidden="true" size={13} /></a> : null}</div></div> : <>
          <div className={styles.deliveryFlow}>
            <article data-ready={repositoryWorkspaceCurrent || undefined}><span>01</span><div><strong>Repository workspace</strong><small>{repositoryWorkspaceCurrent && snapshot.repositoryWorkspace ? `${snapshot.repositoryWorkspace.repositoryFullName} · ${snapshot.repositoryWorkspace.fileCount} files` : snapshot.repositoryBinding ? "Bound · open exact revision" : "Choose selected access"}</small></div><CheckCircle2 aria-hidden="true" size={16} /></article><ChevronRight aria-hidden="true" size={15} />
            <article data-ready={Boolean(currentCheckpoint) || undefined}><span>02</span><div><strong>Sealed revision</strong><small>{currentCheckpoint ? currentCheckpoint.workspaceSha256 : "Checkpoint required"}</small></div><CheckCircle2 aria-hidden="true" size={16} /></article><ChevronRight aria-hidden="true" size={15} />
            <article data-ready={Boolean(deliveryVerification) || undefined}><span>03</span><div><strong>Verification</strong><small>{deliveryVerification ? "Lint + typecheck passed" : "Passing Sentinel receipt required"}</small></div><CheckCircle2 aria-hidden="true" size={16} /></article><ChevronRight aria-hidden="true" size={15} />
            <article data-ready={latestDelivery?.status === "pull_request_open" || undefined}><span>04</span><div><strong>Draft PR</strong><small>{latestDelivery?.status === "pull_request_open" ? `#${latestDelivery.pullRequestNumber}` : "Secret scan runs first"}</small></div><GitBranch aria-hidden="true" size={16} /></article>
          </div>
          <div className={styles.deliveryGrid}>
            <section className={styles.repositoryCard}>
              <div><strong>Destination repository</strong><small>Only GitHub App-selected repositories are visible.</small></div>
              <label htmlFor={`builder-repository-${project.id}`}>Repository</label>
              <div className={styles.repositorySelect}><select id={`builder-repository-${project.id}`} value={selectedRepositoryId || snapshot.repositoryBinding?.repositoryId || ""} onChange={(event) => setSelectedRepositoryId(event.currentTarget.value)} disabled={Boolean(busy)}>{selectedRepositoryId && !repositories.some((row) => row.repositoryId === selectedRepositoryId) ? <option value={selectedRepositoryId}>Selected repository unavailable · {selectedRepositoryId}</option> : null}{repositories.map((repository) => <option value={repository.repositoryId} key={repository.repositoryId}>{repository.fullName} · {repository.private ? "private" : "public"}</option>)}</select><button type="button" onClick={() => void refreshRepositories()} disabled={Boolean(busy)} aria-label="Refresh repositories">{busy === "github.repositories" ? <Loader2 className={styles.spinner} size={14} /> : <RefreshCw aria-hidden="true" size={14} />}</button></div>
              {repositories.some((repository) => repository.repositoryId === (selectedRepositoryId || snapshot.repositoryBinding?.repositoryId)) ? <p className={styles.help}>Selected: {repositories.find((repository) => repository.repositoryId === (selectedRepositoryId || snapshot.repositoryBinding?.repositoryId))?.fullName}</p> : null}
              {repositoryRead.loading ? <p className={styles.help}>Loading repositories…</p> : repositoryRead.error ? <p className={styles.readNotice}>{repositoryRead.loaded ? "Repository refresh failed; showing the last loaded list." : "Repositories unavailable."} {repositoryRead.error}</p> : repositoryRead.loaded && !repositories.length ? <p className={styles.help}>No repositories were returned for this connection.</p> : null}
              {snapshot.repositoryBinding ? <div className={styles.revisionReceipt}><span>Bound to <b>{snapshot.repositoryBinding.defaultBranch}</b></span><code>{snapshot.repositoryBinding.baseSha}</code></div> : null}
              <button type="button" className={styles.secondaryAction} onClick={() => void bindRepository()} disabled={!selectedRepositoryId || !repositories.some((row) => row.repositoryId === selectedRepositoryId) || Boolean(repositoryRead.error) || Boolean(busy) || actionBlocked || dirty}>{busy === "github.bind" ? <Loader2 className={styles.spinner} size={14} /> : <GitBranch aria-hidden="true" size={14} />} {snapshot.repositoryBinding?.repositoryId === selectedRepositoryId ? "Refresh exact revision" : "Bind repository"}</button>
              {snapshot.repositoryBinding ? <button type="button" className={styles.primaryAction} onClick={() => void checkoutRepository()} disabled={Boolean(busy) || repositoryWorkspaceCurrent || actionBlocked || dirty}>{busy === "github.checkout" ? <Loader2 className={styles.spinner} size={14} /> : <FolderGit2 aria-hidden="true" size={14} />} {busy === "github.checkout" ? "Importing exact revision…" : repositoryWorkspaceCurrent ? "Repository open in workspace" : snapshot.repositoryWorkspace ? "Update workspace to bound revision" : "Open repository in workspace"}</button> : null}
            </section>
            <section className={styles.pullRequestCard}>
              <div><strong>Pull request</strong><small>A new branch is required; the default branch is never written directly.</small></div>
              <label htmlFor={`builder-branch-${project.id}`}>New branch</label><input id={`builder-branch-${project.id}`} value={branchName || suggestBranch(project.title, currentCheckpoint?.workspaceSha256)} onChange={(event) => setBranchName(event.currentTarget.value)} maxLength={120} disabled={Boolean(busy)} placeholder="asael/my-app-a1b2c3d4" />
              <label htmlFor={`builder-pr-title-${project.id}`}>Title</label><input id={`builder-pr-title-${project.id}`} value={deliveryTitle} onChange={(event) => setDeliveryTitle(event.currentTarget.value)} maxLength={180} disabled={Boolean(busy)} />
              <label htmlFor={`builder-pr-body-${project.id}`}>Review note <span>optional</span></label><textarea id={`builder-pr-body-${project.id}`} value={deliveryBody} onChange={(event) => setDeliveryBody(event.currentTarget.value)} maxLength={8_000} disabled={Boolean(busy)} rows={3} placeholder="What changed and what should the reviewer inspect?" />
              {!snapshot.repositoryBinding || !currentCheckpoint || !deliveryVerification || deliveryTitle.trim().length < 3 ? <p className={styles.help}>A bound repository, sealed checkpoint, passing verification and Sentinel review, and a title are required.</p> : null}
              <button type="button" className={styles.primaryAction} onClick={() => void createPullRequest()} disabled={Boolean(busy) || actionBlocked || dirty || !snapshot.repositoryBinding || !currentCheckpoint || !deliveryVerification || deliveryTitle.trim().length < 3}>{busy === "github.deliver" ? <Loader2 className={styles.spinner} size={14} /> : <GitBranch aria-hidden="true" size={14} />} {busy === "github.deliver" ? "Scanning and delivering…" : "Secret-scan & open draft PR"}</button>
            </section>
          </div>
          {snapshot.deliveries.length ? <div className={styles.deliveryLedger}>{snapshot.deliveries.map((delivery) => <article key={delivery.id} data-status={delivery.status}><i /><div><strong>{delivery.branchName}</strong><small>{delivery.status.replaceAll("_", " ")} · {new Date(delivery.updatedAt).toLocaleString()}</small>{delivery.failureCode ? <p className={styles.error}>{delivery.failureCode}</p> : null}</div><code>{delivery.commitSha || delivery.failureCode || "preparing"}</code>{safeExternalUrl(delivery.pullRequestUrl) ? <a href={safeExternalUrl(delivery.pullRequestUrl)} target="_blank" rel="noopener noreferrer">Open PR #{delivery.pullRequestNumber} <ExternalLink aria-hidden="true" size={12} /></a> : null}</article>)}</div> : null}
        </>}
      </section> : null}

      {deployOpen ? <section id="builder-preview-delivery" className={styles.deployPanel} aria-label="Vercel preview deployment">
        <header>
          <div><span className={styles.deliveryKicker}>Preview release desk</span><h3>Preview deployment</h3><p>One exact passing checkpoint becomes a Vercel preview. Build logs and static route smokes must both pass before Asael calls it ready.</p></div>
          <div className={styles.deliveryState} data-ready={latestDeployment?.status === "ready" || undefined}><i />{latestDeployment ? deploymentStatusLabel(latestDeployment.status) : snapshot.vercel.configured ? "Connection configured" : "Setup required"}</div>
        </header>
        {!snapshot.vercel.configured ? <div className={styles.githubSetup}><AlertCircle aria-hidden="true" size={18} /><div><strong>Complete the Vercel deployment connection</strong><p>Missing: {snapshot.vercel.missing.join(", ") || "deployment credentials"}. The access token stays in Asael&apos;s server environment and is never placed in the generated app, Agent context, build log, or memory.</p></div></div> : <>
          <div className={styles.previewFlow}>
            <article data-ready={Boolean(currentCheckpoint) || undefined}><span>01</span><div><strong>Sealed source</strong><small>{currentCheckpoint ? currentCheckpoint.workspaceSha256 : "Checkpoint required"}</small></div><CheckCircle2 aria-hidden="true" size={16} /></article>
            <article data-ready={Boolean(deliveryVerification) || undefined}><span>02</span><div><strong>Verified</strong><small>{deliveryVerification ? "Deterministic checks passed" : "Passing evidence required"}</small></div><ShieldCheck aria-hidden="true" size={16} /></article>
            <article data-ready={Boolean(latestDeployment?.providerDeploymentId) || undefined}><span>03</span><div><strong>Vercel build</strong><small>{latestDeployment ? latestDeployment.providerState || "Provider state unavailable" : "No deployment recorded"}</small></div><Rocket aria-hidden="true" size={16} /></article>
            <article data-ready={latestDeployment?.routeEvidence.status === "passed" || undefined}><span>04</span><div><strong>Routes</strong><small>{latestDeployment ? `${latestDeployment.routeEvidence.routes.filter((route) => route.status === "passed").length}/${latestDeployment.smokeRoutes.length} healthy` : "No preview evidence"}</small></div><MonitorPlay aria-hidden="true" size={16} /></article>
            <article data-ready={latestDeployment?.logs.status === "captured" && latestDeployment.routeEvidence.status === "passed" || undefined}><span>05</span><div><strong>Readiness receipt</strong><small>{latestDeployment ? readinessEvidenceLabel(latestDeployment.browserEvidence) : "No readiness receipt"}</small></div><CheckCircle2 aria-hidden="true" size={16} /></article>
          </div>
          <div className={styles.deployGrid}>
            <section className={styles.previewLaunchCard}>
              <div><strong>Exact candidate</strong><small>{matchingDelivery ? `Draft PR #${matchingDelivery.pullRequestNumber} · commit ${matchingDelivery.commitSha || "unavailable"}` : "Current workspace · GitHub handoff can be attached later"}</small></div>
              <div className={styles.releaseCoordinates}><span>Checkpoint ID</span><code>{currentCheckpoint?.id || "not sealed"}</code><span>Workspace SHA-256</span><code>{currentCheckpoint?.workspaceSha256 || "not sealed"}</code><span>Verification</span><code>{deliveryVerification?.id || "not passed"}</code></div>
              <button type="button" className={styles.primaryAction} onClick={() => void createPreviewDeployment()} disabled={Boolean(busy) || actionBlocked || dirty || !currentCheckpoint || !deliveryVerification || latestDeployment?.status === "preparing" || latestDeployment?.status === "queued" || latestDeployment?.status === "building" || latestDeployment?.status === "verifying"}>{busy === "vercel.deploy" ? <Loader2 className={styles.spinner} size={14} /> : <Rocket aria-hidden="true" size={14} />} {busy === "vercel.deploy" ? "Uploading exact source…" : "Create Vercel preview"}</button>
              {!currentCheckpoint || !deliveryVerification ? <p className={styles.help}>Seal the current workspace and obtain passing checks plus Sentinel review before deploying this candidate.</p> : null}
              <small className={styles.productionHold}><ShieldCheck aria-hidden="true" size={13} /> Production remains a separate explicit approval.</small>
            </section>
            <section className={styles.previewEvidenceCard}>
              <div><strong>Deployment evidence</strong><small>{latestDeployment ? new Date(latestDeployment.updatedAt).toLocaleString() : "No preview has been created yet."}</small></div>
              {latestDeployment ? <>
                <div className={styles.evidenceMatrix}>
                  <span data-status={latestDeployment.logs.status}><b>Build log</b><small>{latestDeployment.logs.status === "captured" ? `${latestDeployment.logs.eventCount} events · ${latestDeployment.logs.sha256 || "digest unavailable"}` : latestDeployment.logs.status}</small></span>
                  <span data-status={latestDeployment.routeEvidence.status}><b>Route smoke</b><small>{latestDeployment.routeEvidence.status} · {latestDeployment.routeEvidence.routes.length || latestDeployment.smokeRoutes.length} paths</small></span>
                  <span data-status={latestDeployment.browserEvidence.replacement?.status || "pending"}><b>Readiness receipt</b><small>{readinessEvidenceLabel(latestDeployment.browserEvidence)}</small></span>
                </div>
                {latestDeployment.failureCode ? <p className={styles.error}>Deployment receipt: {latestDeployment.failureCode}</p> : null}
                <div className={styles.previewActions}>{safeExternalUrl(latestDeployment.deploymentUrl) ? <a href={safeExternalUrl(latestDeployment.deploymentUrl)} target="_blank" rel="noopener noreferrer">Open exact preview <ExternalLink aria-hidden="true" size={13} /></a> : null}{latestDeployment.status === "incomplete" ? <button type="button" onClick={() => void refreshPreviewDeployment(latestDeployment)} disabled={Boolean(busy) || !canManage || Boolean(sessionReadError)}>{busy === `vercel.refresh:${latestDeployment.id}` ? <Loader2 className={styles.spinner} size={13} /> : <RefreshCw aria-hidden="true" size={13} />} Retry evidence</button> : null}</div>
              </> : <p>Deploy a passing checkpoint to begin the asynchronous evidence trail.</p>}
            </section>
          </div>
          <section className={styles.productionReleaseCard}>
            <header>
              <div><span className={styles.deliveryKicker}>Production gate</span><strong>Release only the reviewed preview</strong><small>A 15-minute receipt binds preview health, source digest, migration posture, and the exact rollback target.</small></div>
              <div className={styles.deliveryState} data-ready={currentRelease?.status === "healthy" || undefined}><i />{currentRelease ? releaseStatusLabel(currentRelease.status) : "Review required"}</div>
            </header>
            {currentRelease && !releaseMatchesDeployment ? <p className={styles.readNotice}>The selected release belongs to a different preview deployment. Select its exact preview before confirming production.</p> : null}
            {currentRelease?.failureCode ? <p className={styles.error}>Release receipt: {currentRelease.failureCode}</p> : null}
            {latestDeployment?.status !== "ready" ? <p>Complete preview evidence before preparing a production review.</p> : !currentRelease || !releaseMatchesDeployment || currentRelease.status === "expired" || currentRelease.status === "failed" || currentRelease.status === "review_pending" && !canConfirmRelease(currentRelease, Date.now()) ? <div className={styles.productionEmpty}>
              <div><ShieldCheck aria-hidden="true" size={18} /><span><strong>{currentRelease?.status === "failed" ? "The last release failed" : currentRelease?.status === "expired" || currentRelease?.status === "review_pending" && !canConfirmRelease(currentRelease, Date.now()) ? "The review window expired or is blocked" : "Production has not been reviewed"}</strong><small>Prepare a fresh receipt from workspace {latestDeployment.workspaceSha256}.</small></span></div>
              <button type="button" className={styles.secondaryAction} onClick={() => void prepareProductionReview()} disabled={Boolean(busy) || actionBlocked || dirty}>{busy === "release.review" ? <Loader2 className={styles.spinner} size={14} /> : <ShieldCheck aria-hidden="true" size={14} />} Prepare production review</button>
            </div> : <>
              <div className={styles.productionEvidence}>
                <span data-ready><b>Preview proof</b><small>{currentRelease.previewEvidenceSha256}</small></span>
                <span data-ready={currentRelease.migrationEvidence.status === "not_declared" || undefined}><b>Database changes</b><small>{currentRelease.migrationEvidence.status === "not_declared" ? "None declared" : `${currentRelease.migrationEvidence.fileCount} migration files · blocked`}</small></span>
                <span data-ready><b>Rollback</b><small>{currentRelease.rollbackEvidence.status === "available" ? currentRelease.rollbackEvidence.providerDeploymentId || "Target unavailable" : "First production release"}</small></span>
                <span data-ready={currentRelease.status === "healthy" || undefined}><b>Production health</b><small>{currentRelease.status === "healthy" ? `${currentRelease.routeEvidence.routes.length} routes · build logs verified` : releaseStatusLabel(currentRelease.status)}</small></span>
              </div>
              <div className={styles.releaseDigest}><span>Release receipt</span><code>{currentRelease.releaseDigest}</code><small>{currentRelease.status === "review_pending" ? `Expires ${new Date(currentRelease.expiresAt).toLocaleTimeString()}` : currentRelease.providerState || "Receipt sealed"}</small></div>
              {currentRelease.status === "review_pending" || currentRelease.status === "releasing" && !currentRelease.providerDeploymentId ? <div className={styles.releaseConfirmation}>
                <label htmlFor={`builder-production-confirmation-${project.id}`}>{currentRelease.status === "releasing" ? "Provider acknowledgement is unavailable. Inspect the current release state before confirming the same reviewed receipt with " : "Type "}<code>RELEASE</code>{currentRelease.status === "review_pending" ? " to confirm this exact receipt" : null}</label>
                <div><input id={`builder-production-confirmation-${project.id}`} value={productionConfirmation} onChange={(event) => { setProductionConfirmation(event.currentTarget.value); setConfirmationBasis(currentConfirmationBasis); }} disabled={Boolean(busy) || !releaseMatchesDeployment} autoComplete="off" spellCheck={false} placeholder="RELEASE" /><button type="button" onClick={() => void releaseProduction(currentRelease)} disabled={Boolean(busy) || actionBlocked || !confirmedRelease || !releaseMatchesDeployment || !canConfirmRelease(currentRelease, Date.now())}>{busy === "release.production" ? <Loader2 className={styles.spinner} size={14} /> : <Rocket aria-hidden="true" size={14} />} Release to production</button></div>
                {currentRelease.migrationEvidence.status !== "not_declared" ? <p className={styles.help}>Production release is blocked while database migration files are declared.</p> : null}
              </div> : currentRelease.status === "releasing" || currentRelease.status === "building" ? <div className={styles.productionProgress}><Loader2 className={styles.spinner} size={16} /><span>Vercel is building the production deployment. Evidence refresh runs while this Build view is open and your current role permits it.</span></div> : <div className={styles.previewActions}>{safeExternalUrl(currentRelease.deploymentUrl) ? <a href={safeExternalUrl(currentRelease.deploymentUrl)} target="_blank" rel="noopener noreferrer">Open production <ExternalLink aria-hidden="true" size={13} /></a> : null}{currentRelease.status === "incomplete" ? <button type="button" onClick={() => void refreshProductionRelease(currentRelease)} disabled={Boolean(busy) || !canManage || Boolean(sessionReadError)}>{busy === `release.refresh:${currentRelease.id}` ? <Loader2 className={styles.spinner} size={13} /> : <RefreshCw aria-hidden="true" size={13} />} Retry production evidence</button> : null}</div>}
            </>}
          </section>
          {snapshot.deployments.length ? <div className={styles.deploymentLedger}>{snapshot.deployments.map((deployment) => <article key={deployment.id} data-status={deployment.status}><i /><div><strong>{deploymentStatusLabel(deployment.status)}</strong><small>{deployment.commitSha ? `commit ${deployment.commitSha}` : `workspace ${deployment.workspaceSha256}`} · {new Date(deployment.updatedAt).toLocaleString()}</small>{deployment.failureCode ? <p className={styles.error}>{deployment.failureCode}</p> : null}</div><code>{deployment.providerDeploymentId || deployment.failureCode || "preparing"}</code>{safeExternalUrl(deployment.deploymentUrl) ? <a href={safeExternalUrl(deployment.deploymentUrl)} target="_blank" rel="noopener noreferrer">Preview <ExternalLink aria-hidden="true" size={12} /></a> : null}</article>)}</div> : null}
        </>}
      </section> : null}

      <div className={styles.workspace}>
        <aside className={styles.fileRail}>
          <div className={styles.railTabs} role="group" aria-label="Build workspace browser"><button type="button" aria-pressed={rail === "files"} onClick={() => setRail("files")}><Files aria-hidden="true" size={14} /> Files</button><button type="button" aria-pressed={rail === "checkpoints"} onClick={() => setRail("checkpoints")}><RotateCcw aria-hidden="true" size={14} /> Restore</button><button type="button" aria-pressed={rail === "activity"} onClick={() => setRail("activity")}><Activity aria-hidden="true" size={14} /> Activity</button></div>
          {rail === "files" ? <><form className={styles.fileSearch} onSubmit={(event) => { event.preventDefault(); void searchTree(session, fileSearch).catch((readError) => setError(message(readError))); }}><Search aria-hidden="true" size={13} /><input value={fileSearch} onChange={(event) => setFileSearch(event.currentTarget.value)} placeholder="Search source" aria-label="Search source files" /><button type="submit" disabled={!ready || fileSearch.trim().length === 1 || Boolean(busy)}>Find</button>{fileSearch ? <button type="button" onClick={() => { setFileSearch(""); void loadTree(session, file?.path, true).catch((readError) => setError(message(readError))); }}>Clear</button> : null}</form><p className={styles.help}>Use at least two characters to search, or clear the search to show the file tree.</p><div className={styles.fileReadStatus}>{treeRead.loading ? "Loading source files…" : treeRead.error ? `${treeRead.loaded ? "Source refresh failed; showing the last loaded files." : "Source files unavailable."} ${treeRead.error}` : null}</div><div className={styles.fileList} role="region" aria-label="Source files" tabIndex={0}>{files.length ? files.map((entry) => <button type="button" key={entry.path} aria-pressed={!fileSessionMismatch && file?.path === entry.path} disabled={Boolean(busy) || fileRead.loading || !ready} onClick={() => { if (dirty && !window.confirm("Discard the unsaved file change?")) return; void loadFile(session, entry.path).catch((readError) => setError(message(readError))); setView("code"); }}><FileCode2 aria-hidden="true" size={13} /><span>{entry.path}</span><small>{entry.size === undefined ? "Size unavailable" : formatBytes(entry.size)}</small></button>) : <p>{treeRead.loaded ? fileSearch.trim() ? "No editable source matched this search." : "No editable source files in the loaded workspace." : "Source files have not loaded."}</p>}</div></> : rail === "checkpoints" ? <div className={styles.checkpointList}><p className={styles.help}>Up to 20 recent checkpoints; older history is unavailable here.</p>{snapshot.checkpoints.length ? snapshot.checkpoints.map((checkpoint) => { const current = session.currentCheckpointId === checkpoint.id; return <article key={checkpoint.id} data-current={current || undefined}><div><i /><span>{current ? "Current seal" : checkpointReason(checkpoint.reason)}</span></div><strong>{checkpoint.label}</strong><small>{new Date(checkpoint.createdAt).toLocaleString()} · {checkpoint.fileCount} files</small><code>{checkpoint.id}</code><code>{checkpoint.workspaceSha256}</code>{checkpoint.expiresAt ? <small>Restore expires {new Date(checkpoint.expiresAt).toLocaleString()}</small> : null}<button type="button" onClick={() => void restoreCheckpoint(checkpoint)} disabled={Boolean(busy) || dirty || current || actionBlocked || Boolean(checkpoint.expiresAt && Date.parse(checkpoint.expiresAt) <= Date.now())}>{busy === `restore:${checkpoint.id}` ? <Loader2 className={styles.spinner} size={12} /> : <RotateCcw aria-hidden="true" size={12} />} {current ? "Current" : "Restore"}</button></article>; }) : <p>No checkpoints yet. Save one before a risky change.</p>}</div> : <div className={styles.activityList}><p className={styles.help}>Up to 40 recent events; this is a bounded history.</p>{snapshot.activity.length ? snapshot.activity.map((item) => <article key={item.id}><i /><div><strong>{eventLabel(item.eventType)}</strong><small>{new Date(item.occurredAt).toLocaleString()}</small>{activityDetail(item)}</div></article>) : <p>No build activity yet.</p>}</div>}
        </aside>

        <div className={styles.canvas}>
          <div className={styles.canvasTabs} role="group" aria-label="Build canvas view"><button type="button" aria-pressed={view === "preview"} onClick={() => setView("preview")}><MonitorPlay aria-hidden="true" size={14} /> Preview</button><button type="button" aria-pressed={view === "code"} onClick={() => setView("code")}><Code2 aria-hidden="true" size={14} /> Code{dirty ? <span className={styles.unsavedLabel}> · unsaved</span> : null}</button><span>{file?.path || "No file selected"}</span></div>
          {view === "preview" ? <div className={styles.previewFrame}>{active && ready && safePreview ? <iframe key={`${snapshot.previewUrl}:${previewGeneration}`} src={safePreview} title={`${project.title} live preview`} sandbox="allow-forms allow-same-origin allow-scripts" referrerPolicy="no-referrer" /> : <div><MonitorPlay aria-hidden="true" size={24} /><span>An isolated HTTPS preview is unavailable in this snapshot.</span><p>Restart preview to request a preview from the workspace.</p></div>}</div> : <div className={styles.editor}><div><span>{file?.path}</span><small>{file ? `${formatBytes(file.size)} · SHA-256 ${file.sha256}` : ""}</small></div><textarea aria-label={`Edit ${file?.path || "file"}`} spellCheck={false} value={draft} onChange={(event) => setDraft(event.currentTarget.value)} disabled={!file || fileRead.loading || Boolean(busy)} readOnly={fileSessionMismatch || !ready || !canManage} aria-describedby={fileSessionMismatch ? "builder-session-change" : undefined} /><footer><span>{fileSessionMismatch ? dirty ? "Retained draft · previous session" : "Retained file · previous session" : dirty ? "Unsaved change" : file ? "Saved at the loaded revision" : "No file loaded"}</span><div className={styles.editorActions}><button type="button" className={styles.deleteAction} onClick={() => void deleteFile()} disabled={!file || dirty || Boolean(busy) || fileSessionMismatch || actionBlocked}>{busy === "delete" ? <Loader2 className={styles.spinner} size={13} /> : <Trash2 aria-hidden="true" size={13} />} Delete</button><button type="button" onClick={() => void saveFile()} disabled={!dirty || Boolean(busy) || fileSessionMismatch || actionBlocked}>{busy === "save" ? <Loader2 className={styles.spinner} size={13} /> : <Save aria-hidden="true" size={13} />} Save file</button></div></footer></div>}
          {fileRead.loading || fileRead.error ? <p className={styles.readNotice}>{fileRead.loading ? `Opening ${fileRead.path}…` : `Could not open ${fileRead.path}. ${file ? `The previous file, ${file.path}, is retained.` : "No file is loaded."} ${fileRead.error}`}</p> : null}
          <div className={styles.checks}><div><SquareTerminal aria-hidden="true" size={14} /><span>Focused checks</span></div>{commands.map((command) => <button type="button" key={command} onClick={() => void runCommand(command)} disabled={Boolean(busy) || dirty || actionBlocked}>{busy === command ? <Loader2 className={styles.spinner} size={12} /> : <CheckCircle2 aria-hidden="true" size={12} />} {command}</button>)}</div>
          {commandOutput ? <pre className={styles.output} role="region" aria-label="Build command output" tabIndex={0}>{commandOutput}</pre> : null}
        </div>

        <aside className={styles.forgeRail}>
          <div className={styles.forgeIdentity}><span>F</span><div><strong>Forge</strong><small>Code builder · Settings model</small></div>{busy === "forge" ? <span className={styles.agentState}>Request in progress</span> : null}</div>
          <p>Describe a complete change. Forge can inspect this workspace, update SHA-fenced files, run focused checks, and refresh the preview.</p>
          {agentOutput ? <div className={styles.agentOutput} role="region" aria-label="Forge output" tabIndex={0}>{agentOutput}</div> : <div className={styles.suggestion}><WandSparkles aria-hidden="true" size={15} /><span>Try “Turn this starter into a personal research dashboard with a responsive mobile view.”</span></div>}
          <form onSubmit={askForge}><label htmlFor={`forge-prompt-${project.id}`}>What should Forge build?</label><textarea id={`forge-prompt-${project.id}`} value={prompt} onChange={(event) => setPrompt(event.currentTarget.value)} rows={5} maxLength={4_000} disabled={Boolean(busy) || !canManage || !ready} placeholder="Describe the outcome, audience, and must-have behavior…" /><button type="submit" disabled={!prompt.trim() || Boolean(busy) || dirty || actionBlocked}>{busy === "forge" ? <Loader2 className={styles.spinner} size={14} /> : <Send aria-hidden="true" size={14} />} {busy === "forge" ? "Forge is working" : dirty ? "Save file before Forge" : "Build with Forge"}</button></form>
          <section className={styles.sentinelCard}>
            <div><span>S</span><div><strong>Sentinel</strong><small>Independent verifier · Settings model</small></div>{latestVerification ? <i data-status={latestSentinelReview?.detail.verdict === "blocked" ? "failed" : latestVerification.status}>{latestSentinelReview?.detail.verdict === "passed" ? "passed" : latestSentinelReview?.detail.verdict === "blocked" ? "blocked" : latestVerification.status === "passed" ? "checks passed" : latestVerification.status}</i> : null}</div>
            <p>Seal this revision, run lint and typecheck, then ask Sentinel for a separate verdict bound to that exact checkpoint.</p>
            {latestVerification ? <div className={styles.evidenceStrip}><span>{latestVerification.checks.filter((check) => check.status === "passed").length}/2 checks</span><span>{readinessEvidenceLabel(latestVerification.browserEvidence)}</span><code>{latestVerification.workspaceSha256}</code></div> : null}
            {sentinelOutput ? <div className={styles.sentinelOutput} role="region" aria-label="Sentinel output" tabIndex={0}>{sentinelOutput}</div> : null}
            <button type="button" onClick={() => void verifyWithSentinel()} disabled={Boolean(busy) || dirty || actionBlocked}>{busy === "sentinel" ? <Loader2 className={styles.spinner} size={13} /> : <ShieldCheck aria-hidden="true" size={13} />} {busy === "sentinel" ? "Verifying this revision" : dirty ? "Save file before review" : "Verify with Sentinel"}</button>
          </section>
          <footer><ShieldCheck aria-hidden="true" size={13} /><span>Builder actions use the governed project service and exact revision checks. Production requires a separate reviewed receipt and confirmation.</span></footer>
        </aside>
      </div>
    </section>
  );
}

function message(error: unknown) { return error instanceof Error ? error.message : "App Builder operation failed."; }
function formatBytes(size: number) { return size < 1_024 ? `${size} B` : `${(size / 1_024).toFixed(size > 10_240 ? 0 : 1)} KB`; }
function checkpointReason(value: BuilderCheckpoint["reason"]) { return value.replaceAll("_", " "); }
function eventLabel(value: string) { return value.replace("app_builder.", "").replaceAll("_", " ").replaceAll(".", " · "); }
function readinessEvidenceLabel(evidence: BuilderBrowserEvidence) {
  return evidence.replacement
    ? `${evidence.replacement.status} · deterministic ${evidence.replacement.phase}`
    : `legacy ${evidence.status} · retired from readiness`;
}
function activityDetail(item: BuilderActivity) {
  const detail = item.detail;
  const text = typeof detail.path === "string" ? detail.path : typeof detail.command === "string" ? `${detail.command} · exit ${String(detail.exitCode ?? "—")}` : typeof detail.verdict === "string" ? `Verdict · ${detail.verdict}` : typeof detail.repositoryFullName === "string" ? detail.repositoryFullName : typeof detail.branchName === "string" ? detail.branchName : "";
  return text ? <span>{text}</span> : null;
}
function suggestBranch(title: string, workspaceSha256?: string) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "app";
  return `asael/${slug}-${(workspaceSha256 || "revision").slice(0, 8)}`;
}
function deploymentStatusLabel(value: BuilderDeployment["status"]) {
  return value === "ready" ? "Evidence ready" : value === "incomplete" ? "Evidence incomplete" : value.replaceAll("_", " ");
}
function releaseStatusLabel(value: BuilderRelease["status"]) {
  return value === "review_pending" ? "Awaiting confirmation" : value === "healthy" ? "Production healthy" : value === "incomplete" ? "Health evidence incomplete" : value.replaceAll("_", " ");
}
