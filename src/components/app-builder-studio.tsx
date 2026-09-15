"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
  Loader2,
  MonitorPlay,
  RotateCcw,
  Play,
  RefreshCw,
  Rocket,
  Save,
  Send,
  ShieldCheck,
  SquareTerminal,
  WandSparkles,
} from "lucide-react";
import { buildAppBuilderAgentRequest } from "@/lib/app-builder/agent-request";
import styles from "./app-builder-studio.module.css";

type BuildProject = Readonly<{ id: string; title: string; objective: string; status: string }>;
type BuilderSession = Readonly<{ id: string; projectId: string; status: "provisioning" | "ready" | "running" | "failed" | "stopped"; revision: number; currentCheckpointId?: string; templateId: string; lastErrorCode?: string; updatedAt: string }>;
type BuilderActivity = Readonly<{ id: string; eventType: string; detail: Record<string, unknown>; occurredAt: string }>;
type BuilderCheckpoint = Readonly<{ id: string; sessionId: string; workspaceSha256: string; fileCount: number; snapshotBytes: number; reason: "manual" | "before_forge" | "after_forge" | "before_sentinel" | "before_restore"; label: string; sourceRunId?: string; sessionRevision: number; createdAt: string; expiresAt?: string }>;
type BuilderVerification = Readonly<{ id: string; sessionId: string; checkpointId: string; workspaceSha256: string; status: "passed" | "failed" | "incomplete"; checks: ReadonlyArray<{ command: "lint" | "typecheck"; status: "passed" | "failed"; exitCode: number; durationMs: number; outputSha256: string }>; browserEvidence: { status: "captured" | "unavailable" | "failed"; captures: ReadonlyArray<{ viewport: "desktop" | "mobile"; width: number; height: number; screenshotSha256: string; mimeType: string; byteLength: number }>; errorCode?: string }; createdAt: string }>;
type TreeEntry = Readonly<{ path: string; kind: "file" | "directory"; size?: number }>;
type BuilderFile = Readonly<{ path: string; content: string; sha256: string; size: number }>;
type GithubStatus = Readonly<{ configured: boolean; missing: string[]; appSlug?: string; installUrl?: string }>;
type VercelStatus = Readonly<{ configured: boolean; missing: string[] }>;
type BuilderRepository = Readonly<{ repositoryId: string; owner: string; name: string; fullName: string; private: boolean; defaultBranch: string; htmlUrl: string }>;
type RepositoryBinding = Readonly<{ id: string; repositoryId: string; repositoryFullName: string; private: boolean; defaultBranch: string; baseSha: string; revision: number; updatedAt: string }>;
type BuilderDelivery = Readonly<{ id: string; repositoryBindingId: string; checkpointId: string; verificationId: string; workspaceSha256: string; baseSha: string; branchName: string; commitSha?: string; pullRequestNumber?: number; pullRequestUrl?: string; secretScanSha256: string; secretFindingCount: number; status: "preparing" | "pull_request_open" | "failed"; failureCode?: string; createdAt: string; updatedAt: string }>;
type BuilderDeployment = Readonly<{ id: string; checkpointId: string; verificationId: string; repositoryDeliveryId?: string; commitSha?: string; workspaceSha256: string; fileManifestSha256: string; fileCount: number; byteCount: number; secretScanSha256: string; smokeRoutes: string[]; providerDeploymentId?: string; providerState?: string; deploymentUrl?: string; status: "preparing" | "queued" | "building" | "verifying" | "ready" | "incomplete" | "failed"; logs: { status: "pending" | "captured" | "unavailable"; sha256?: string; eventCount: number }; routeEvidence: { status: "pending" | "passed" | "failed"; routes: ReadonlyArray<{ path: string; status: "passed" | "failed"; statusCode?: number; durationMs: number; bodySha256?: string; errorCode?: string }> }; browserEvidence: { status: "pending" | "captured" | "unavailable" | "failed"; captures: ReadonlyArray<{ viewport: "desktop" | "mobile"; width: number; height: number; screenshotSha256: string; mimeType: string; byteLength: number }>; errorCode?: string }; failureCode?: string; createdAt: string; updatedAt: string }>;
type BuilderRelease = Readonly<{ id: string; deploymentId: string; previewProviderDeploymentId: string; workspaceSha256: string; previewEvidenceSha256: string; releaseDigest: string; migrationEvidence: { status: "not_declared" | "declared"; fileCount: number; manifestSha256: string }; rollbackEvidence: { status: "available" | "first_release"; providerDeploymentId?: string; deploymentUrl?: string }; status: "review_pending" | "releasing" | "building" | "healthy" | "incomplete" | "failed" | "expired"; providerDeploymentId?: string; providerState?: string; deploymentUrl?: string; logs: BuilderDeployment["logs"]; routeEvidence: BuilderDeployment["routeEvidence"]; browserEvidence: BuilderDeployment["browserEvidence"]; failureCode?: string; createdAt: string; updatedAt: string; expiresAt: string; releasedAt?: string }>;
type SessionPayload = Readonly<{ session: BuilderSession | null; activity: BuilderActivity[]; checkpoints: BuilderCheckpoint[]; verifications: BuilderVerification[]; repositoryBinding: RepositoryBinding | null; deliveries: BuilderDelivery[]; deployments: BuilderDeployment[]; releases: BuilderRelease[]; github: GithubStatus; vercel: VercelStatus; previewUrl: string | null }>;
type AgentEvent = { type?: string; runId?: string; text?: string; response?: string; message?: string; label?: string; detail?: string; toolName?: string; status?: string };

const commands = ["lint", "typecheck", "test", "build"] as const;

export function AppBuilderStudio({ project }: { project: BuildProject }) {
  const [snapshot, setSnapshot] = useState<SessionPayload>({ session: null, activity: [], checkpoints: [], verifications: [], repositoryBinding: null, deliveries: [], deployments: [], releases: [], github: { configured: false, missing: [] }, vercel: { configured: false, missing: [] }, previewUrl: null });
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [file, setFile] = useState<BuilderFile>();
  const [draft, setDraft] = useState("");
  const [view, setView] = useState<"preview" | "code">("preview");
  const [rail, setRail] = useState<"files" | "checkpoints" | "activity">("files");
  const [prompt, setPrompt] = useState("");
  const [agentOutput, setAgentOutput] = useState("");
  const [sentinelOutput, setSentinelOutput] = useState("");
  const [commandOutput, setCommandOutput] = useState("");
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
  const session = snapshot.session;
  const ready = session?.status === "ready" || session?.status === "running";
  const dirty = Boolean(file && draft !== file.content);
  const latestVerification = snapshot.verifications[0];
  const deliveryVerification = snapshot.verifications.find((verification) =>
    verification.status === "passed" && verification.checkpointId === session?.currentCheckpointId,
  );
  const currentCheckpoint = snapshot.checkpoints.find((checkpoint) => checkpoint.id === session?.currentCheckpointId);
  const latestDelivery = snapshot.deliveries[0];
  const latestDeployment = snapshot.deployments[0];
  const currentRelease = snapshot.releases.find((release) => release.deploymentId === latestDeployment?.id);
  const matchingDelivery = snapshot.deliveries.find((delivery) =>
    delivery.status === "pull_request_open" &&
    delivery.checkpointId === currentCheckpoint?.id &&
    delivery.verificationId === deliveryVerification?.id,
  );

  const loadSession = useCallback(async () => {
    const payload = await readJson<SessionPayload>(`/api/projects/${encodeURIComponent(project.id)}/builder`);
    setSnapshot(payload);
    return payload;
  }, [project.id]);

  const loadFile = useCallback(async (target: BuilderSession, path: string) => {
    const payload = await readJson<{ file: BuilderFile }>(`/api/projects/${encodeURIComponent(project.id)}/builder?view=file&sessionId=${encodeURIComponent(target.id)}&path=${encodeURIComponent(path)}`);
    setFile(payload.file);
    setDraft(payload.file.content);
  }, [project.id]);

  const loadTree = useCallback(async (target: BuilderSession, preferredPath?: string) => {
    const payload = await readJson<{ entries: TreeEntry[] }>(`/api/projects/${encodeURIComponent(project.id)}/builder?view=tree&sessionId=${encodeURIComponent(target.id)}`);
    setTree(payload.entries);
    const paths = payload.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path);
    const nextPath = preferredPath && paths.includes(preferredPath) ? preferredPath : paths.includes("app/page.tsx") ? "app/page.tsx" : paths[0];
    if (nextPath) await loadFile(target, nextPath);
  }, [loadFile, project.id]);

  const loadRepositories = useCallback(async () => {
    const payload = await readJson<{ repositories: BuilderRepository[] }>(`/api/projects/${encodeURIComponent(project.id)}/builder?view=github.repositories`);
    setRepositories(payload.repositories);
    setSelectedRepositoryId((current) => current || snapshot.repositoryBinding?.repositoryId || payload.repositories[0]?.repositoryId || "");
    return payload.repositories;
  }, [project.id, snapshot.repositoryBinding?.repositoryId]);

  useEffect(() => {
    let active = true;
    async function initialize() {
      try {
        const payload = await readJson<SessionPayload>(`/api/projects/${encodeURIComponent(project.id)}/builder`);
        if (!active) return;
        setSnapshot(payload);
        if (payload.session && (payload.session.status === "ready" || payload.session.status === "running")) {
          await loadTree(payload.session);
        }
      } catch (loadError) {
        if (active) setError(message(loadError));
      } finally {
        if (active) setBusy("");
      }
    }
    void initialize();
    return () => { active = false; };
  }, [loadTree, project.id]);

  useEffect(() => {
    if (
      !session || !latestDeployment ||
      !new Set<BuilderDeployment["status"]>(["queued", "building", "verifying"]).has(latestDeployment.status)
    ) return;
    let active = true;
    const timer = window.setTimeout(async () => {
      try {
        const payload = await mutate<{ deployment: BuilderDeployment }>(project.id, {
          action: "deployment.refresh",
          sessionId: session.id,
          deploymentId: latestDeployment.id,
        });
        if (!active) return;
        setSnapshot((current) => ({
          ...current,
          deployments: [payload.deployment, ...current.deployments.filter((item) => item.id !== payload.deployment.id)],
        }));
      } catch (refreshError) {
        if (active) setError(message(refreshError));
      }
    }, 4_500);
    return () => { active = false; window.clearTimeout(timer); };
  }, [latestDeployment, project.id, session]);

  useEffect(() => {
    if (!session || !currentRelease?.providerDeploymentId || !new Set<BuilderRelease["status"]>(["releasing", "building"]).has(currentRelease.status)) return;
    let active = true;
    const timer = window.setTimeout(async () => {
      try {
        const payload = await mutate<{ release: BuilderRelease }>(project.id, {
          action: "release.refresh",
          sessionId: session.id,
          releaseId: currentRelease.id,
        });
        if (!active) return;
        setSnapshot((current) => ({
          ...current,
          releases: [payload.release, ...current.releases.filter((item) => item.id !== payload.release.id)],
        }));
      } catch (refreshError) {
        if (active) setError(message(refreshError));
      }
    }, 4_500);
    return () => { active = false; window.clearTimeout(timer); };
  }, [currentRelease, project.id, session]);

  async function createWorkspace() {
    setBusy("create");
    setError(undefined);
    try {
      const payload = await mutate<SessionPayload & { created: boolean }>(project.id, { action: "create" }, `builder-create:${project.id}`);
      setSnapshot((current) => ({ ...current, ...payload }));
      if (payload.session) await loadTree(payload.session);
    } catch (createError) {
      setError(message(createError));
    } finally {
      setBusy("");
    }
  }

  async function saveFile() {
    if (!session || !file || !dirty) return;
    setBusy("save");
    setError(undefined);
    try {
      await mutate(project.id, { action: "file.update", sessionId: session.id, path: file.path, expectedSha256: file.sha256, content: draft });
      await loadFile(session, file.path);
      await loadSession();
    } catch (saveError) {
      setError(message(saveError));
    } finally {
      setBusy("");
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
    if (!session || dirty) return;
    setBusy("checkpoint");
    setError(undefined);
    try {
      await createCheckpoint(session, "manual", `Saved revision ${session.revision}`);
      setRail("checkpoints");
    } catch (checkpointError) {
      setError(message(checkpointError));
    } finally {
      setBusy("");
    }
  }

  async function restoreCheckpoint(checkpoint: BuilderCheckpoint) {
    if (!session || dirty || session.currentCheckpointId === checkpoint.id) return;
    if (!window.confirm(`Restore “${checkpoint.label}”? Asael will save the current workspace first.`)) return;
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
      setError(message(restoreError));
    } finally {
      setBusy("");
    }
  }

  async function runCommand(command: typeof commands[number] | "start_preview") {
    if (!session) return;
    setBusy(command);
    setError(undefined);
    setCommandOutput("");
    try {
      const payload = await mutate<{ result: { exitCode: number; stdout: string; stderr: string; durationMs: number } }>(project.id, { action: "command.run", sessionId: session.id, command });
      setCommandOutput([payload.result.stdout, payload.result.stderr].filter(Boolean).join("\n") || `${command} completed with exit code ${payload.result.exitCode}.`);
      if (command === "start_preview") await loadSession();
      await loadSession();
    } catch (commandError) {
      setError(message(commandError));
    } finally {
      setBusy("");
    }
  }

  async function askForge(event: React.FormEvent) {
    event.preventDefault();
    const request = prompt.trim();
    if (!request || !session || dirty) return;
    setBusy("forge");
    setAgentOutput("");
    setError(undefined);
    try {
      const sealed = await createCheckpoint(session, "before_forge", `Before Forge · ${request.slice(0, 90)}`);
      if (!sealed.session) throw new Error("The recovery checkpoint did not return an active session.");
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildAppBuilderAgentRequest({
          projectId: project.id,
          message: `Work only in App Builder session ${session.id} for project ${project.id}. Inspect files before editing and preserve SHA-256 fences. User request: ${request}. Run focused checks and restart the preview when complete.`,
          requestId: crypto.randomUUID(),
          agentId: "forge",
        })),
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error(String(body.error || body.message || `Forge returned ${response.status}`));
      }
      let accumulated = "";
      let runId = "";
      let completed = false;
      await readSse(response.body, (agentEvent) => {
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
        setAgentOutput(accumulated.trim());
      });
      setPrompt("");
      const refreshed = await loadSession();
      let finalSnapshot = refreshed;
      if (completed && runId && refreshed.session) {
        finalSnapshot = await createCheckpoint(refreshed.session, "after_forge", `Forge result · ${request.slice(0, 88)}`, runId);
      }
      if (finalSnapshot.session) await loadTree(finalSnapshot.session, file?.path);
    } catch (agentError) {
      setError(message(agentError));
    } finally {
      setBusy("");
    }
  }

  async function verifyWithSentinel() {
    if (!session || dirty) return;
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
      setSnapshot((current) => ({ ...current, verifications: [verification, ...current.verifications.filter((item) => item.id !== verification.id)] }));
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildAppBuilderAgentRequest({
          projectId: project.id,
          message: `Independently review App Builder verification ${verification.id} at checkpoint ${verification.checkpointId} in session ${sealed.session.id}. Use the governed verification receipt and inspect the project files. Project objective: ${project.objective}. Deterministic evidence: ${JSON.stringify(verification)}. Return a concise PASS or BLOCK verdict, specific evidence, and the smallest corrective actions. Never claim to have seen screenshot pixels; only digest metadata is available.`,
          requestId: crypto.randomUUID(),
          agentId: "sentinel",
        })),
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error(String(body.error || body.message || `Sentinel returned ${response.status}`));
      }
      let accumulated = "";
      let runId = "";
      let completed = false;
      await readSse(response.body, (agentEvent) => {
        if (agentEvent.type === "run" && agentEvent.runId) runId = agentEvent.runId;
        if (agentEvent.type === "delta" && agentEvent.text) accumulated += agentEvent.text;
        if (agentEvent.type === "done") {
          completed = true;
          if (agentEvent.response) accumulated = agentEvent.response;
        }
        if (agentEvent.type === "status" && !accumulated) accumulated = [agentEvent.label, agentEvent.detail].filter(Boolean).join(" — ");
        if (agentEvent.type === "tool") accumulated += `\n${agentEvent.toolName || "Tool"}: ${agentEvent.status || "working"}`;
        if (agentEvent.type === "error") throw new Error(agentEvent.message || "Sentinel stopped unexpectedly.");
        setSentinelOutput(accumulated.trim());
      });
      if (!completed || !runId) throw new Error("Sentinel did not produce a completed review receipt.");
      await mutate(project.id, {
        action: "sentinel.record",
        sessionId: sealed.session.id,
        verificationId: verification.id,
        sourceRunId: runId,
      });
      await loadSession();
    } catch (verificationError) {
      setError(message(verificationError));
    } finally {
      setBusy("");
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
      setError(message(repositoryError));
    } finally {
      setBusy("");
    }
  }

  async function bindRepository() {
    if (!session || !selectedRepositoryId) return;
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
      setError(message(bindingError));
    } finally {
      setBusy("");
    }
  }

  async function refreshRepositories() {
    setBusy("github.repositories");
    setError(undefined);
    try {
      await loadRepositories();
    } catch (repositoryError) {
      setError(message(repositoryError));
    } finally {
      setBusy("");
    }
  }

  async function createPullRequest() {
    const binding = snapshot.repositoryBinding;
    if (!session || !binding || !currentCheckpoint || !deliveryVerification) return;
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
        deliveries: [payload.delivery, ...current.deliveries.filter((item) => item.id !== payload.delivery.id)],
      }));
      await loadSession();
    } catch (deliveryError) {
      setError(message(deliveryError));
      await loadSession().catch(() => undefined);
    } finally {
      setBusy("");
    }
  }

  function toggleDeploy() {
    setDeployOpen((current) => !current);
    setGithubOpen(false);
    setError(undefined);
  }

  async function createPreviewDeployment() {
    if (!session || !currentCheckpoint || !deliveryVerification) return;
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
        deployments: [payload.deployment, ...current.deployments.filter((item) => item.id !== payload.deployment.id)],
      }));
      await loadSession();
    } catch (deploymentError) {
      setError(message(deploymentError));
      await loadSession().catch(() => undefined);
    } finally {
      setBusy("");
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
        deployments: [payload.deployment, ...current.deployments.filter((item) => item.id !== payload.deployment.id)],
      }));
      await loadSession();
    } catch (refreshError) {
      setError(message(refreshError));
    } finally {
      setBusy("");
    }
  }

  async function prepareProductionReview() {
    if (!session || !latestDeployment || latestDeployment.status !== "ready") return;
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
        releases: [payload.release, ...current.releases.filter((item) => item.id !== payload.release.id)],
      }));
      await loadSession();
    } catch (reviewError) {
      setError(message(reviewError));
    } finally {
      setBusy("");
    }
  }

  async function releaseProduction(release: BuilderRelease) {
    if (!session || productionConfirmation !== "RELEASE") return;
    if (!window.confirm("Release this exact reviewed preview to the production URL?")) return;
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
        releases: [payload.release, ...current.releases.filter((item) => item.id !== payload.release.id)],
      }));
      setProductionConfirmation("");
      await loadSession();
    } catch (releaseError) {
      setError(message(releaseError));
      await loadSession().catch(() => undefined);
    } finally {
      setBusy("");
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
        releases: [payload.release, ...current.releases.filter((item) => item.id !== payload.release.id)],
      }));
      await loadSession();
    } catch (refreshError) {
      setError(message(refreshError));
    } finally {
      setBusy("");
    }
  }

  const files = useMemo(() => tree.filter((entry) => entry.kind === "file"), [tree]);

  if (busy === "loading") return <section className={styles.loading}><Loader2 className="animate-spin" size={20} /><span>Opening the build studio…</span></section>;

  if (!session) return (
    <section className={styles.empty}>
      <div className={styles.emptyMark}><WandSparkles size={28} /></div>
      <p>Build mode</p>
      <h3>Turn this project into a working app.</h3>
      <span>Forge gets a private Next.js workspace with inspected file edits, fixed verification commands, and a live preview. The sandbox can reach the package registry only.</span>
      <div className={styles.guardrails}><span><ShieldCheck size={14} /> Project-scoped</span><span><Code2 size={14} /> TypeScript starter</span><span><MonitorPlay size={14} /> Private preview</span></div>
      <button type="button" onClick={() => void createWorkspace()} disabled={busy === "create" || project.status === "archived"}>{busy === "create" ? <Loader2 className="animate-spin" size={15} /> : <Play size={15} />} Create build workspace</button>
      {error ? <p className={styles.error} role="alert"><AlertCircle size={14} /> {error}</p> : null}
    </section>
  );

  if (!ready) return (
    <section className={styles.empty}>
      <div className={styles.emptyMark}><AlertCircle size={28} /></div>
      <p>Build workspace · {session.status}</p>
      <h3>{session.status === "failed" ? "The sandbox needs attention." : "The workspace is not running."}</h3>
      <span>{session.lastErrorCode ? `Provisioning receipt: ${session.lastErrorCode}` : "Its files and activity remain recorded."}</span>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </section>
  );

  return (
    <section className={styles.studio} aria-busy={Boolean(busy)}>
      <header className={styles.studioHeader}>
        <div><span className={styles.liveDot} /><div><strong>Build studio</strong><small>{session.templateId} · revision {session.revision}</small></div></div>
        <div className={styles.headerActions}>
          <button type="button" onClick={() => void saveCheckpoint()} disabled={Boolean(busy) || dirty} title={dirty ? "Save the open file before sealing a checkpoint" : "Save a recoverable checkpoint"}><Save size={14} /> Checkpoint</button>
          <button type="button" onClick={() => void runCommand("start_preview")} disabled={Boolean(busy)} title="Restart preview"><RefreshCw size={14} className={busy === "start_preview" ? "animate-spin" : undefined} /></button>
          {snapshot.previewUrl ? <a href={snapshot.previewUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open preview</a> : null}
          <button type="button" onClick={() => { setDeployOpen(false); void toggleGithub(); }} aria-expanded={githubOpen} disabled={Boolean(busy) && busy !== "github.repositories"} title="Review and deliver this build through the private GitHub App"><GitBranch size={14} /> GitHub</button>
          <button type="button" onClick={toggleDeploy} aria-expanded={deployOpen} disabled={Boolean(busy)} title="Create and verify a revision-bound Vercel preview"><Rocket size={14} /> Deploy</button>
        </div>
      </header>

      {error ? <div className={styles.errorBanner} role="alert"><AlertCircle size={15} /><span>{error}</span><button type="button" onClick={() => setError(undefined)}>Dismiss</button></div> : null}

      {githubOpen ? <section className={styles.deliveryPanel} aria-label="GitHub delivery">
        <header><div><span className={styles.deliveryKicker}>Source handoff</span><h3>Open a reviewable pull request</h3><p>Asael writes only to a new branch in one repository selected for the private GitHub App.</p></div><div className={styles.deliveryState} data-ready={snapshot.github.configured || undefined}><i />{snapshot.github.configured ? "GitHub App ready" : "Setup required"}</div></header>
        {!snapshot.github.configured ? <div className={styles.githubSetup}><AlertCircle size={18} /><div><strong>Complete the private GitHub App connection</strong><p>Missing: {snapshot.github.missing.join(", ") || "application credentials"}. Grant selected-repository access with Contents and Pull requests write plus Checks read. Asael mints a short-lived token for the selected repository only.</p>{snapshot.github.installUrl ? <a href={snapshot.github.installUrl} target="_blank" rel="noreferrer">Install the GitHub App <ExternalLink size={13} /></a> : null}</div></div> : <>
          <div className={styles.deliveryFlow}>
            <article data-ready={Boolean(snapshot.repositoryBinding) || undefined}><span>01</span><div><strong>Repository</strong><small>{snapshot.repositoryBinding ? snapshot.repositoryBinding.repositoryFullName : "Choose selected access"}</small></div><CheckCircle2 size={16} /></article><ChevronRight size={15} />
            <article data-ready={Boolean(currentCheckpoint) || undefined}><span>02</span><div><strong>Sealed revision</strong><small>{currentCheckpoint ? currentCheckpoint.workspaceSha256.slice(0, 10) : "Checkpoint required"}</small></div><CheckCircle2 size={16} /></article><ChevronRight size={15} />
            <article data-ready={Boolean(deliveryVerification) || undefined}><span>03</span><div><strong>Verification</strong><small>{deliveryVerification ? "Checks + visual evidence passed" : "Passing Sentinel receipt required"}</small></div><CheckCircle2 size={16} /></article><ChevronRight size={15} />
            <article data-ready={latestDelivery?.status === "pull_request_open" || undefined}><span>04</span><div><strong>Draft PR</strong><small>{latestDelivery?.status === "pull_request_open" ? `#${latestDelivery.pullRequestNumber}` : "Secret scan runs first"}</small></div><GitBranch size={16} /></article>
          </div>
          <div className={styles.deliveryGrid}>
            <section className={styles.repositoryCard}>
              <div><strong>Destination repository</strong><small>Only GitHub App-selected repositories are visible.</small></div>
              <label htmlFor={`builder-repository-${project.id}`}>Repository</label>
              <div className={styles.repositorySelect}><select id={`builder-repository-${project.id}`} value={selectedRepositoryId || snapshot.repositoryBinding?.repositoryId || ""} onChange={(event) => setSelectedRepositoryId(event.currentTarget.value)} disabled={busy === "github.repositories"}>{repositories.map((repository) => <option value={repository.repositoryId} key={repository.repositoryId}>{repository.fullName} · {repository.private ? "private" : "public"}</option>)}</select><button type="button" onClick={() => void refreshRepositories()} disabled={Boolean(busy)} aria-label="Refresh repositories">{busy === "github.repositories" ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}</button></div>
              {snapshot.repositoryBinding ? <div className={styles.revisionReceipt}><span>Bound to <b>{snapshot.repositoryBinding.defaultBranch}</b></span><code>{snapshot.repositoryBinding.baseSha.slice(0, 12)}</code></div> : null}
              <button type="button" className={styles.secondaryAction} onClick={() => void bindRepository()} disabled={!selectedRepositoryId || Boolean(busy)}>{busy === "github.bind" ? <Loader2 className="animate-spin" size={14} /> : <GitBranch size={14} />} {snapshot.repositoryBinding?.repositoryId === selectedRepositoryId ? "Refresh exact revision" : "Bind repository"}</button>
            </section>
            <section className={styles.pullRequestCard}>
              <div><strong>Pull request</strong><small>A new branch is required; the default branch is never written directly.</small></div>
              <label htmlFor={`builder-branch-${project.id}`}>New branch</label><input id={`builder-branch-${project.id}`} value={branchName || suggestBranch(project.title, currentCheckpoint?.workspaceSha256)} onChange={(event) => setBranchName(event.currentTarget.value)} maxLength={120} placeholder="asael/my-app-a1b2c3d4" />
              <label htmlFor={`builder-pr-title-${project.id}`}>Title</label><input id={`builder-pr-title-${project.id}`} value={deliveryTitle} onChange={(event) => setDeliveryTitle(event.currentTarget.value)} maxLength={180} />
              <label htmlFor={`builder-pr-body-${project.id}`}>Review note <span>optional</span></label><textarea id={`builder-pr-body-${project.id}`} value={deliveryBody} onChange={(event) => setDeliveryBody(event.currentTarget.value)} maxLength={8_000} rows={3} placeholder="What changed and what should the reviewer inspect?" />
              <button type="button" className={styles.primaryAction} onClick={() => void createPullRequest()} disabled={Boolean(busy) || !snapshot.repositoryBinding || !currentCheckpoint || !deliveryVerification || !deliveryTitle.trim()}>{busy === "github.deliver" ? <Loader2 className="animate-spin" size={14} /> : <GitBranch size={14} />} {busy === "github.deliver" ? "Scanning and delivering…" : "Secret-scan & open draft PR"}</button>
            </section>
          </div>
          {snapshot.deliveries.length ? <div className={styles.deliveryLedger}>{snapshot.deliveries.slice(0, 4).map((delivery) => <article key={delivery.id} data-status={delivery.status}><i /><div><strong>{delivery.branchName}</strong><small>{delivery.status.replaceAll("_", " ")} · {new Date(delivery.updatedAt).toLocaleString()}</small></div><code>{delivery.commitSha?.slice(0, 10) || delivery.failureCode || "preparing"}</code>{delivery.pullRequestUrl ? <a href={delivery.pullRequestUrl} target="_blank" rel="noreferrer">Open PR #{delivery.pullRequestNumber} <ExternalLink size={12} /></a> : null}</article>)}</div> : null}
        </>}
      </section> : null}

      {deployOpen ? <section className={styles.deployPanel} aria-label="Vercel preview deployment">
        <header>
          <div><span className={styles.deliveryKicker}>Preview release desk</span><h3>Ship evidence before production</h3><p>One exact passing checkpoint becomes an isolated Vercel preview. Build logs, static routes, and desktop/mobile captures must all resolve before Asael calls it ready.</p></div>
          <div className={styles.deliveryState} data-ready={latestDeployment?.status === "ready" || undefined}><i />{latestDeployment ? deploymentStatusLabel(latestDeployment.status) : snapshot.vercel.configured ? "Ready to deploy" : "Setup required"}</div>
        </header>
        {!snapshot.vercel.configured ? <div className={styles.githubSetup}><AlertCircle size={18} /><div><strong>Complete the Vercel deployment connection</strong><p>Missing: {snapshot.vercel.missing.join(", ") || "deployment credentials"}. The access token stays in Asael&apos;s server environment and is never placed in the generated app, Agent context, build log, or memory.</p></div></div> : <>
          <div className={styles.previewFlow}>
            <article data-ready={Boolean(currentCheckpoint) || undefined}><span>01</span><div><strong>Sealed source</strong><small>{currentCheckpoint ? currentCheckpoint.workspaceSha256.slice(0, 10) : "Checkpoint required"}</small></div><CheckCircle2 size={16} /></article>
            <article data-ready={Boolean(deliveryVerification) || undefined}><span>02</span><div><strong>Verified</strong><small>{deliveryVerification ? "Checks + private views passed" : "Passing evidence required"}</small></div><ShieldCheck size={16} /></article>
            <article data-ready={Boolean(latestDeployment?.providerDeploymentId) || undefined}><span>03</span><div><strong>Vercel build</strong><small>{latestDeployment?.providerState || "Not queued"}</small></div><Rocket size={16} /></article>
            <article data-ready={latestDeployment?.routeEvidence.status === "passed" || undefined}><span>04</span><div><strong>Routes</strong><small>{latestDeployment ? `${latestDeployment.routeEvidence.routes.filter((route) => route.status === "passed").length}/${latestDeployment.smokeRoutes.length} healthy` : "Static paths discovered"}</small></div><MonitorPlay size={16} /></article>
            <article data-ready={latestDeployment?.browserEvidence.status === "captured" || undefined}><span>05</span><div><strong>Visual proof</strong><small>{latestDeployment ? `${latestDeployment.browserEvidence.captures.length}/2 views` : "Desktop + mobile"}</small></div><CheckCircle2 size={16} /></article>
          </div>
          <div className={styles.deployGrid}>
            <section className={styles.previewLaunchCard}>
              <div><strong>Exact candidate</strong><small>{matchingDelivery ? `Draft PR #${matchingDelivery.pullRequestNumber} · commit ${matchingDelivery.commitSha?.slice(0, 10)}` : "Current verified workspace · GitHub handoff can be attached later"}</small></div>
              <div className={styles.releaseCoordinates}><span>Checkpoint</span><code>{currentCheckpoint?.workspaceSha256.slice(0, 16) || "not sealed"}</code><span>Verification</span><code>{deliveryVerification?.id.slice(-12) || "not passed"}</code></div>
              <button type="button" className={styles.primaryAction} onClick={() => void createPreviewDeployment()} disabled={Boolean(busy) || !currentCheckpoint || !deliveryVerification || latestDeployment?.status === "preparing" || latestDeployment?.status === "queued" || latestDeployment?.status === "building" || latestDeployment?.status === "verifying"}>{busy === "vercel.deploy" ? <Loader2 className="animate-spin" size={14} /> : <Rocket size={14} />} {busy === "vercel.deploy" ? "Uploading exact source…" : "Create Vercel preview"}</button>
              <small className={styles.productionHold}><ShieldCheck size={13} /> Production remains a separate explicit approval.</small>
            </section>
            <section className={styles.previewEvidenceCard}>
              <div><strong>Deployment evidence</strong><small>{latestDeployment ? new Date(latestDeployment.updatedAt).toLocaleString() : "No preview has been created yet."}</small></div>
              {latestDeployment ? <>
                <div className={styles.evidenceMatrix}>
                  <span data-status={latestDeployment.logs.status}><b>Build log</b><small>{latestDeployment.logs.status === "captured" ? `${latestDeployment.logs.eventCount} events · ${latestDeployment.logs.sha256?.slice(0, 10)}` : latestDeployment.logs.status}</small></span>
                  <span data-status={latestDeployment.routeEvidence.status}><b>Route smoke</b><small>{latestDeployment.routeEvidence.status} · {latestDeployment.routeEvidence.routes.length || latestDeployment.smokeRoutes.length} paths</small></span>
                  <span data-status={latestDeployment.browserEvidence.status}><b>Visual smoke</b><small>{latestDeployment.browserEvidence.status} · {latestDeployment.browserEvidence.captures.length} captures</small></span>
                </div>
                <div className={styles.previewActions}>{latestDeployment.deploymentUrl ? <a href={latestDeployment.deploymentUrl} target="_blank" rel="noreferrer">Open exact preview <ExternalLink size={13} /></a> : null}{latestDeployment.status === "incomplete" ? <button type="button" onClick={() => void refreshPreviewDeployment(latestDeployment)} disabled={Boolean(busy)}>{busy === `vercel.refresh:${latestDeployment.id}` ? <Loader2 className="animate-spin" size={13} /> : <RefreshCw size={13} />} Retry evidence</button> : null}</div>
              </> : <p>Deploy a passing checkpoint to begin the asynchronous evidence trail.</p>}
            </section>
          </div>
          <section className={styles.productionReleaseCard}>
            <header>
              <div><span className={styles.deliveryKicker}>Production gate</span><strong>Release only the reviewed preview</strong><small>A 15-minute receipt binds preview health, source digest, migration posture, and the exact rollback target.</small></div>
              <div className={styles.deliveryState} data-ready={currentRelease?.status === "healthy" || undefined}><i />{currentRelease ? releaseStatusLabel(currentRelease.status) : "Review required"}</div>
            </header>
            {latestDeployment?.status !== "ready" ? <p>Complete preview evidence before preparing a production review.</p> : !currentRelease || currentRelease.status === "expired" || currentRelease.status === "failed" ? <div className={styles.productionEmpty}>
              <div><ShieldCheck size={18} /><span><strong>{currentRelease?.status === "failed" ? "The last release failed safely" : currentRelease?.status === "expired" ? "The review window expired" : "Production has not been reviewed"}</strong><small>Prepare a fresh receipt from workspace {latestDeployment.workspaceSha256.slice(0, 12)}.</small></span></div>
              <button type="button" className={styles.secondaryAction} onClick={() => void prepareProductionReview()} disabled={Boolean(busy)}>{busy === "release.review" ? <Loader2 className="animate-spin" size={14} /> : <ShieldCheck size={14} />} Prepare production review</button>
            </div> : <>
              <div className={styles.productionEvidence}>
                <span data-ready><b>Preview proof</b><small>{currentRelease.previewEvidenceSha256.slice(0, 12)}</small></span>
                <span data-ready={currentRelease.migrationEvidence.status === "not_declared" || undefined}><b>Database changes</b><small>{currentRelease.migrationEvidence.status === "not_declared" ? "None declared" : `${currentRelease.migrationEvidence.fileCount} migration files · blocked`}</small></span>
                <span data-ready><b>Rollback</b><small>{currentRelease.rollbackEvidence.status === "available" ? currentRelease.rollbackEvidence.providerDeploymentId?.slice(0, 15) : "First production release"}</small></span>
                <span data-ready={currentRelease.status === "healthy" || undefined}><b>Production health</b><small>{currentRelease.status === "healthy" ? `${currentRelease.routeEvidence.routes.length} routes · ${currentRelease.browserEvidence.captures.length} views` : releaseStatusLabel(currentRelease.status)}</small></span>
              </div>
              <div className={styles.releaseDigest}><span>Release receipt</span><code>{currentRelease.releaseDigest.slice(0, 24)}</code><small>{currentRelease.status === "review_pending" ? `Expires ${new Date(currentRelease.expiresAt).toLocaleTimeString()}` : currentRelease.providerState || "Receipt sealed"}</small></div>
              {currentRelease.status === "review_pending" || currentRelease.status === "releasing" && !currentRelease.providerDeploymentId ? <div className={styles.releaseConfirmation}>
                <label htmlFor={`builder-production-confirmation-${project.id}`}>{currentRelease.status === "releasing" ? "Provider acknowledgement was interrupted. Resume the same idempotent receipt with " : "Type "}<code>RELEASE</code>{currentRelease.status === "review_pending" ? " to confirm this exact receipt" : null}</label>
                <div><input id={`builder-production-confirmation-${project.id}`} value={productionConfirmation} onChange={(event) => setProductionConfirmation(event.currentTarget.value)} autoComplete="off" spellCheck={false} placeholder="RELEASE" /><button type="button" onClick={() => void releaseProduction(currentRelease)} disabled={Boolean(busy) || productionConfirmation !== "RELEASE" || currentRelease.migrationEvidence.status !== "not_declared"}>{busy === "release.production" ? <Loader2 className="animate-spin" size={14} /> : <Rocket size={14} />} Release to production</button></div>
              </div> : currentRelease.status === "releasing" || currentRelease.status === "building" ? <div className={styles.productionProgress}><Loader2 className="animate-spin" size={16} /><span>Vercel is building the production deployment. Asael will verify it automatically.</span></div> : <div className={styles.previewActions}>{currentRelease.deploymentUrl ? <a href={currentRelease.deploymentUrl} target="_blank" rel="noreferrer">Open production <ExternalLink size={13} /></a> : null}{currentRelease.status === "incomplete" ? <button type="button" onClick={() => void refreshProductionRelease(currentRelease)} disabled={Boolean(busy)}>{busy === `release.refresh:${currentRelease.id}` ? <Loader2 className="animate-spin" size={13} /> : <RefreshCw size={13} />} Retry production evidence</button> : null}</div>}
            </>}
          </section>
          {snapshot.deployments.length ? <div className={styles.deploymentLedger}>{snapshot.deployments.slice(0, 5).map((deployment) => <article key={deployment.id} data-status={deployment.status}><i /><div><strong>{deploymentStatusLabel(deployment.status)}</strong><small>{deployment.commitSha ? `commit ${deployment.commitSha.slice(0, 10)}` : `workspace ${deployment.workspaceSha256.slice(0, 10)}`} · {new Date(deployment.updatedAt).toLocaleString()}</small></div><code>{deployment.providerDeploymentId?.slice(0, 14) || deployment.failureCode || "preparing"}</code>{deployment.deploymentUrl ? <a href={deployment.deploymentUrl} target="_blank" rel="noreferrer">Preview <ExternalLink size={12} /></a> : null}</article>)}</div> : null}
        </>}
      </section> : null}

      <div className={styles.workspace}>
        <aside className={styles.fileRail}>
          <div className={styles.railTabs} role="tablist"><button type="button" className={rail === "files" ? styles.selected : undefined} onClick={() => setRail("files")}><Files size={14} /> Files</button><button type="button" className={rail === "checkpoints" ? styles.selected : undefined} onClick={() => setRail("checkpoints")}><RotateCcw size={14} /> Restore</button><button type="button" className={rail === "activity" ? styles.selected : undefined} onClick={() => setRail("activity")}><Activity size={14} /> Activity</button></div>
          {rail === "files" ? <div className={styles.fileList}>{files.map((entry) => <button type="button" key={entry.path} className={file?.path === entry.path ? styles.selectedFile : undefined} onClick={() => { if (dirty && !window.confirm("Discard the unsaved file change?")) return; void loadFile(session, entry.path); setView("code"); }}><FileCode2 size={13} /><span>{entry.path}</span><small>{formatBytes(entry.size || 0)}</small></button>)}</div> : rail === "checkpoints" ? <div className={styles.checkpointList}>{snapshot.checkpoints.length ? snapshot.checkpoints.map((checkpoint) => { const current = session.currentCheckpointId === checkpoint.id; return <article key={checkpoint.id} data-current={current || undefined}><div><i /><span>{current ? "Current seal" : checkpointReason(checkpoint.reason)}</span></div><strong>{checkpoint.label}</strong><small>{new Date(checkpoint.createdAt).toLocaleString()} · {checkpoint.fileCount} files</small><code>{checkpoint.workspaceSha256.slice(0, 12)}</code><button type="button" onClick={() => void restoreCheckpoint(checkpoint)} disabled={Boolean(busy) || dirty || current}>{busy === `restore:${checkpoint.id}` ? <Loader2 className="animate-spin" size={12} /> : <RotateCcw size={12} />} {current ? "Current" : "Restore"}</button></article>; }) : <p>No checkpoints yet. Save one before a risky change.</p>}</div> : <div className={styles.activityList}>{snapshot.activity.length ? snapshot.activity.map((item) => <article key={item.id}><i /><div><strong>{eventLabel(item.eventType)}</strong><small>{new Date(item.occurredAt).toLocaleString()}</small>{activityDetail(item)}</div></article>) : <p>No build activity yet.</p>}</div>}
        </aside>

        <div className={styles.canvas}>
          <div className={styles.canvasTabs} role="tablist"><button type="button" className={view === "preview" ? styles.selected : undefined} onClick={() => setView("preview")}><MonitorPlay size={14} /> Preview</button><button type="button" className={view === "code" ? styles.selected : undefined} onClick={() => setView("code")}><Code2 size={14} /> Code{dirty ? <i /> : null}</button><span>{file?.path || "No file selected"}</span></div>
          {view === "preview" ? <div className={styles.previewFrame}>{snapshot.previewUrl ? <iframe key={snapshot.previewUrl} src={snapshot.previewUrl} title={`${project.title} live preview`} sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts" /> : <div><Loader2 className="animate-spin" /><span>Preview is waking up…</span></div>}</div> : <div className={styles.editor}><div><span>{file?.path}</span><small>{file ? `${formatBytes(file.size)} · ${file.sha256.slice(0, 10)}…` : ""}</small></div><textarea aria-label={`Edit ${file?.path || "file"}`} spellCheck={false} value={draft} onChange={(event) => setDraft(event.currentTarget.value)} disabled={!file} /><footer><span>{dirty ? "Unsaved change" : "Saved at exact revision"}</span><button type="button" onClick={() => void saveFile()} disabled={!dirty || busy === "save"}>{busy === "save" ? <Loader2 className="animate-spin" size={13} /> : <Save size={13} />} Save file</button></footer></div>}
          <div className={styles.checks}><div><SquareTerminal size={14} /><span>Focused checks</span></div>{commands.map((command) => <button type="button" key={command} onClick={() => void runCommand(command)} disabled={Boolean(busy) || dirty}>{busy === command ? <Loader2 className="animate-spin" size={12} /> : <CheckCircle2 size={12} />} {command}</button>)}</div>
          {commandOutput ? <pre className={styles.output}>{commandOutput}</pre> : null}
        </div>

        <aside className={styles.forgeRail}>
          <div className={styles.forgeIdentity}><span>F</span><div><strong>Forge</strong><small>Code builder · Settings model</small></div><i className={busy === "forge" ? styles.thinking : undefined} /></div>
          <p>Describe a complete change. Forge can inspect this workspace, update SHA-fenced files, run focused checks, and refresh the preview.</p>
          {agentOutput ? <div className={styles.agentOutput}>{agentOutput}</div> : <div className={styles.suggestion}><WandSparkles size={15} /><span>Try “Turn this starter into a personal research dashboard with a responsive mobile view.”</span></div>}
          <form onSubmit={askForge}><label htmlFor={`forge-prompt-${project.id}`}>What should Forge build?</label><textarea id={`forge-prompt-${project.id}`} value={prompt} onChange={(event) => setPrompt(event.currentTarget.value)} rows={5} maxLength={4_000} placeholder="Describe the outcome, audience, and must-have behavior…" /><button type="submit" disabled={!prompt.trim() || Boolean(busy) || dirty}>{busy === "forge" ? <Loader2 className="animate-spin" size={14} /> : <Send size={14} />} {busy === "forge" ? "Forge is working" : dirty ? "Save file before Forge" : "Build with Forge"}</button></form>
          <section className={styles.sentinelCard}>
            <div><span>S</span><div><strong>Sentinel</strong><small>Independent verifier · Settings model</small></div>{latestVerification ? <i data-status={latestVerification.status}>{latestVerification.status}</i> : null}</div>
            <p>Seal this revision, run focused checks, capture private desktop and mobile evidence, then ask Sentinel for a separate verdict.</p>
            {latestVerification ? <div className={styles.evidenceStrip}><span>{latestVerification.checks.filter((check) => check.status === "passed").length}/2 checks</span><span>{latestVerification.browserEvidence.captures.length}/2 views</span><code>{latestVerification.workspaceSha256.slice(0, 9)}</code></div> : null}
            {sentinelOutput ? <div className={styles.sentinelOutput}>{sentinelOutput}</div> : null}
            <button type="button" onClick={() => void verifyWithSentinel()} disabled={Boolean(busy) || dirty}>{busy === "sentinel" ? <Loader2 className="animate-spin" size={13} /> : <ShieldCheck size={13} />} {busy === "sentinel" ? "Verifying this revision" : dirty ? "Save file before review" : "Verify with Sentinel"}</button>
          </section>
          <footer><ShieldCheck size={13} /><span>Mutations use governed tools. Consequential actions still pause for approval.</span></footer>
        </aside>
      </div>
    </section>
  );
}

async function mutate<T = Record<string, unknown>>(projectId: string, body: Record<string, unknown>, idempotencyKey = crypto.randomUUID()) {
  return readJson<T>(`/api/projects/${encodeURIComponent(projectId)}/builder`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey }, body: JSON.stringify(body) });
}

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(body.error || body.message || `${path} returned ${response.status}`));
  return body as T;
}

async function readSse(stream: ReadableStream<Uint8Array>, onEvent: (event: AgentEvent) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.replaceAll("\r\n", "\n").split("\n\n");
    buffer = blocks.pop() || "";
    blocks.forEach((block) => emitSse(block, onEvent));
  }
  buffer += decoder.decode();
  buffer.replaceAll("\r\n", "\n").split("\n\n").forEach((block) => emitSse(block, onEvent));
}

function emitSse(block: string, onEvent: (event: AgentEvent) => void) {
  const payload = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n").trim();
  if (payload) onEvent(JSON.parse(payload) as AgentEvent);
}

function message(error: unknown) { return error instanceof Error ? error.message : "App Builder operation failed."; }
function formatBytes(size: number) { return size < 1_024 ? `${size} B` : `${(size / 1_024).toFixed(size > 10_240 ? 0 : 1)} KB`; }
function checkpointReason(value: BuilderCheckpoint["reason"]) { return value.replaceAll("_", " "); }
function eventLabel(value: string) { return value.replace("app_builder.", "").replaceAll("_", " ").replaceAll(".", " · "); }
function activityDetail(item: BuilderActivity) {
  const detail = item.detail;
  const text = typeof detail.path === "string" ? detail.path : typeof detail.command === "string" ? `${detail.command} · exit ${String(detail.exitCode ?? "—")}` : typeof detail.repositoryFullName === "string" ? detail.repositoryFullName : typeof detail.branchName === "string" ? detail.branchName : "";
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
