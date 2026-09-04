"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Archive,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleDot,
  Columns3,
  FileText,
  GitBranch,
  Inbox,
  LayoutList,
  Loader2,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  SquareKanban,
  TriangleAlert,
  UserRound,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import {
  permissionMessage,
  useWorkspaceSession,
} from "@/components/app-shell/session-context";
import type { CapabilityDescriptor } from "@/lib/capabilities/types";
import type { MissionDetailView, MissionSummaryView } from "@/lib/missions/public";
import type { MissionStatus } from "@/lib/missions/types";
import { canonicalStatusForMission } from "@/lib/status/canonical";
import styles from "@/components/missions/mission-workspace.module.css";

type ViewMode = "board" | "canvas" | "list";
type BoardColumnId = "inbox" | "waiting" | "ready" | "working" | "needs-you" | "review" | "done";
type TaskFilter = "all" | "open" | "attention" | "done";
type AgentOption = {
  id: string;
  name: string;
  role?: string;
  selectable: boolean;
};
type BoardComment = { id: string; body: string; authorName?: string; createdAt: string; taskId?: string };

type BaseTask = MissionDetailView["tasks"][number];
type BoardTask = Omit<BaseTask, "status"> & {
  status: string;
  metadata?: Record<string, unknown>;
  assigneeId?: string;
  assigneeName?: string;
  reviewRequired?: boolean;
  scheduledFor?: string;
  blockerReason?: string;
  retryCount?: number;
  maxAttempts?: number;
  comments?: BoardComment[];
};

type BaseArtifact = MissionDetailView["artifacts"][number];
type BoardArtifact = BaseArtifact & {
  metadata?: Record<string, unknown>;
  data?: Record<string, unknown>;
  preview?: string;
};

type BoardMissionDetail = Omit<MissionDetailView, "tasks" | "artifacts"> & {
  tasks: BoardTask[];
  artifacts: BoardArtifact[];
  comments?: BoardComment[];
};

type BoardColumn = { id: BoardColumnId; title: string; description: string };

type MissionReadContract = "readable_v1" | undefined;
type MissionSelectionMode = "exact" | "retained" | "unverified";

export function missionCollectionIsReadable(contract: unknown): contract is "readable_v1" {
  return contract === "readable_v1";
}

export function missionSelectionMode(
  mission: Pick<MissionSummaryView, "detailAvailable"> | undefined,
  contract: unknown,
  loading = false,
): MissionSelectionMode | undefined {
  if (!mission) return undefined;
  if (loading || !missionCollectionIsReadable(contract)) return "unverified";
  return mission.detailAvailable === true ? "exact" : "retained";
}

export function missionCreateActionBlocked({
  contract,
  loading,
  permissionBlocked,
}: {
  contract: unknown;
  loading: boolean;
  permissionBlocked?: string;
}) {
  if (loading) return "Mission ownership is being refreshed.";
  if (!missionCollectionIsReadable(contract)) {
    return "Mission ownership could not be verified. Refresh Missions and try again.";
  }
  return permissionBlocked;
}

export function missionTaskActionBlocked({
  mission,
  contract,
  loading,
  permissionBlocked,
}: {
  mission: Pick<MissionSummaryView, "manageable"> | undefined;
  contract: unknown;
  loading: boolean;
  permissionBlocked?: string;
}) {
  const collectionBlocked = missionCreateActionBlocked({
    contract,
    loading,
    permissionBlocked,
  });
  if (collectionBlocked) return collectionBlocked;
  if (mission?.manageable !== true) {
    return "This retained mission is read only in this session.";
  }
  return undefined;
}

export function missionCommandActionBlocked({
  mission,
  contract,
  loading,
  permissionBlocked,
}: {
  mission: Pick<MissionSummaryView, "runnable"> | undefined;
  contract: unknown;
  loading: boolean;
  permissionBlocked?: string;
}) {
  const collectionBlocked = missionCreateActionBlocked({
    contract,
    loading,
    permissionBlocked,
  });
  if (collectionBlocked) return collectionBlocked;
  if (mission?.runnable !== true) {
    return "This retained mission cannot enter Command from this session.";
  }
  return undefined;
}

export function disableMissionSummaryCapabilities(
  missions: MissionSummaryView[],
) {
  return missions.map((mission) => ({
    ...mission,
    detailAvailable: false,
    manageable: false,
    runnable: false,
  }));
}

export function missionRequestIsCurrent({
  currentController,
  requestController,
  currentGeneration,
  requestGeneration,
}: {
  currentController: AbortController | null;
  requestController: AbortController;
  currentGeneration: number;
  requestGeneration: number;
}) {
  return currentController === requestController &&
    currentGeneration === requestGeneration &&
    !requestController.signal.aborted;
}

export function missionDetailRequestIsCurrent(
  currentGeneration: number,
  requestGeneration: number,
) {
  return currentGeneration === requestGeneration;
}

export function missionEventFailureClosesRow({
  status,
  invalidDetail = false,
}: {
  status?: number;
  invalidDetail?: boolean;
}) {
  return invalidDetail || status === 401 || status === 403 || status === 404;
}

export function missionFailureClearsCollection(status: number | undefined) {
  return status === 401 || status === 403;
}

export function missionBaseSelection(
  missions: Array<Pick<MissionSummaryView, "id">>,
  baseSelection: string,
  fallbackSelection = "",
) {
  if (missions.some((mission) => mission.id === baseSelection)) return baseSelection;
  if (missions.some((mission) => mission.id === fallbackSelection)) return fallbackSelection;
  return missions[0]?.id || "";
}

export function missionNeedsDeepExactReproof(
  missions: Array<Pick<MissionSummaryView, "id">>,
  routeMissionId: string,
) {
  return Boolean(
    routeMissionId &&
    !missions.some((mission) => mission.id === routeMissionId),
  );
}

export function missionRouteSelection(
  missions: Array<Pick<MissionSummaryView, "id">>,
  routeMissionId: string,
  baseSelection: string,
) {
  if (routeMissionId) {
    return missions.some((mission) => mission.id === routeMissionId)
      ? routeMissionId
      : "";
  }
  return missionBaseSelection(missions, baseSelection);
}

export function missionRouteAfterReproof(
  missions: Array<Pick<MissionSummaryView, "id">>,
  routeMissionId: string,
  baseSelection: string,
  routeMissionMissing: boolean,
) {
  if (routeMissionMissing) {
    return {
      selectedId: missionBaseSelection(missions, baseSelection),
      replacePath: "/app/missions" as const,
    };
  }
  return {
    selectedId: missionRouteSelection(missions, routeMissionId, baseSelection),
    replacePath: undefined,
  };
}

const BOARD_COLUMNS: BoardColumn[] = [
  { id: "inbox", title: "Inbox", description: "Needs shaping" },
  { id: "waiting", title: "Waiting", description: "Dependency or schedule" },
  { id: "ready", title: "Ready", description: "Clear to start" },
  { id: "working", title: "Working", description: "Work in progress" },
  { id: "needs-you", title: "Needs you", description: "Input required" },
  { id: "review", title: "Review", description: "Evidence ready" },
  { id: "done", title: "Done", description: "Terminal work" },
];

export function MissionWorkspace({
  initialMissionId = "",
  initialMissions,
  initialCapabilities,
  initialDetail,
  initialMissionReadContract,
  initialEventCursor = 0,
  initialAsOf = 0,
}: {
  initialMissionId?: string;
  initialMissions?: MissionSummaryView[];
  initialCapabilities?: CapabilityDescriptor[];
  initialDetail?: MissionDetailView;
  initialMissionReadContract?: "readable_v1";
  initialEventCursor?: number;
  initialAsOf?: number;
}) {
  const pathname = usePathname();
  const { session, status: sessionStatus, refresh: refreshSession } = useWorkspaceSession();
  const hasInitialWorkspace = initialMissions !== undefined &&
    initialCapabilities !== undefined &&
    missionCollectionIsReadable(initialMissionReadContract);
  const initialRows = hasInitialWorkspace
    ? initialMissions || []
    : disableMissionSummaryCapabilities(initialMissions || []);
  const normalizedInitialDetail = initialDetail
    ? normalizeMissionDetail(initialDetail, initialDetail.mission.id)
    : undefined;
  const initialDetailRow = normalizedInitialDetail
    ? initialRows.find((mission) => mission.id === normalizedInitialDetail.mission.id)
    : undefined;
  const safeInitialDetail = normalizedInitialDetail &&
      initialDetailRow?.detailAvailable === true &&
      missionDetailHasExpectedId(normalizedInitialDetail, normalizedInitialDetail.mission.id)
    ? normalizedInitialDetail as BoardMissionDetail
    : undefined;
  const [missions, setMissions] = useState<MissionSummaryView[]>(initialRows);
  const missionsRef = useRef(missions);
  const [missionReadContract, setMissionReadContract] = useState<MissionReadContract>(
    hasInitialWorkspace ? "readable_v1" : undefined,
  );
  const missionReadContractRef = useRef<MissionReadContract>(
    hasInitialWorkspace ? "readable_v1" : undefined,
  );
  const [details, setDetails] = useState<Record<string, BoardMissionDetail>>(
    safeInitialDetail ? { [safeInitialDetail.mission.id]: safeInitialDetail } : {},
  );
  const detailsRef = useRef(details);
  const [capabilities, setCapabilities] = useState<CapabilityDescriptor[]>(initialCapabilities || []);
  const initialSelectionId = initialMissionId || safeInitialDetail?.mission.id || initialRows[0]?.id || "";
  const baseSelectionRef = useRef(safeInitialDetail?.mission.id || initialRows[0]?.id || "");
  const [selectedId, setSelectedId] = useState(initialSelectionId);
  const selectedIdRef = useRef(initialSelectionId);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(!hasInitialWorkspace);
  const loadingRef = useRef(!hasInitialWorkspace);
  const [showLoading, setShowLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showTaskCreate, setShowTaskCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [mutatingTaskId, setMutatingTaskId] = useState("");
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [priority, setPriority] = useState<MissionSummaryView["priority"]>("normal");
  const [view, setView] = useState<ViewMode>("board");
  const [search, setSearch] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState("all");
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
  const [mobileColumn, setMobileColumn] = useState<BoardColumnId>("ready");
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string>();
  const [taskActionError, setTaskActionError] = useState<string>();
  const [announcement, setAnnouncement] = useState("Mission board is ready.");
  const [asOf, setAsOf] = useState(initialAsOf);
  const listController = useRef<AbortController | null>(null);
  const listGeneration = useRef(0);
  const detailController = useRef<AbortController | null>(null);
  const detailGeneration = useRef(0);
  const detailRequestGeneration = useRef(0);
  const eventController = useRef<AbortController | null>(null);
  const eventGeneration = useRef(0);
  const mutationRecoveryController = useRef<AbortController | null>(null);
  const mutationGeneration = useRef(0);
  const available = Boolean(session && (!session.authEnabled || session.authenticated));
  const sessionOwnerKey = session?.context?.tenantId && session.context.actorId
    ? `${session.context.tenantId}\u0000${session.context.actorId}`
    : undefined;
  const lastVerifiedOwnerKey = useRef(
    hasInitialWorkspace ? sessionOwnerKey : undefined,
  );
  const selectedDetail = selectedId ? details[selectedId] : undefined;
  const selectedMission = missions.find((mission) => mission.id === selectedId);
  const selectedMissionStatus = selectedMission?.status;
  const selectedTask = selectedDetail?.tasks.find((task) => task.id === selectedTaskId);
  const createPermissionBlocked = permissionMessage(session, sessionStatus, "run.agent");
  const taskPermissionBlocked = permissionMessage(session, sessionStatus, "manage.workflow");
  const createActionBlocked = missionCreateActionBlocked({
    contract: missionReadContract,
    loading,
    permissionBlocked: createPermissionBlocked,
  });
  const taskActionBlocked = missionTaskActionBlocked({
    mission: selectedMission,
    contract: missionReadContract,
    loading,
    permissionBlocked: taskPermissionBlocked,
  });
  const commandActionBlocked = missionCommandActionBlocked({
    mission: selectedMission,
    contract: missionReadContract,
    loading,
    permissionBlocked: createPermissionBlocked,
  });
  const selectionMode = missionSelectionMode(
    selectedMission,
    missionReadContract,
    loading,
  );
  const summarySelectionMode: Exclude<MissionSelectionMode, "exact"> =
    selectionMode === "retained" ? "retained" : "unverified";
  const sessionProblem = sessionStatus === "error"
    ? "We could not verify your session. Try reconnecting."
    : sessionStatus === "ready" && !available ? "Sign in to open Missions." : undefined;
  const displayError = error || sessionProblem;
  const workspaceLoading = loading && !sessionProblem;

  const replaceMissions = useCallback((nextMissions: MissionSummaryView[]) => {
    missionsRef.current = nextMissions;
    setMissions(nextMissions);
  }, []);

  const replaceDetails = useCallback((nextDetails: Record<string, BoardMissionDetail>) => {
    detailsRef.current = nextDetails;
    setDetails(nextDetails);
  }, []);

  const replaceMissionReadContract = useCallback((contract: MissionReadContract) => {
    missionReadContractRef.current = contract;
    setMissionReadContract(contract);
  }, []);

  const replaceLoading = useCallback((nextLoading: boolean) => {
    loadingRef.current = nextLoading;
    setLoading(nextLoading);
  }, []);

  const clearRowActionability = useCallback(() => {
    detailGeneration.current += 1;
    detailRequestGeneration.current += 1;
    const activeDetailController = detailController.current;
    detailController.current = null;
    activeDetailController?.abort();
    const activeEventController = eventController.current;
    eventController.current = null;
    eventGeneration.current += 1;
    activeEventController?.abort();
    mutationGeneration.current += 1;
    const activeRecoveryController = mutationRecoveryController.current;
    mutationRecoveryController.current = null;
    activeRecoveryController?.abort();
    replaceMissionReadContract(undefined);
    replaceMissions(disableMissionSummaryCapabilities(missionsRef.current));
    replaceDetails({});
    setDetailLoading(false);
    setSelectedTaskId("");
    setShowCreate(false);
    setShowTaskCreate(false);
    setCreating(false);
    setCreatingTask(false);
    setMutatingTaskId("");
    setTaskActionError(undefined);
  }, [replaceDetails, replaceMissionReadContract, replaceMissions]);

  const invalidateMissionRow = useCallback((missionId: string) => {
    detailGeneration.current += 1;
    detailRequestGeneration.current += 1;
    const activeDetailController = detailController.current;
    detailController.current = null;
    activeDetailController?.abort();
    eventGeneration.current += 1;
    const activeEventController = eventController.current;
    eventController.current = null;
    activeEventController?.abort();
    mutationGeneration.current += 1;
    const activeRecoveryController = mutationRecoveryController.current;
    mutationRecoveryController.current = null;
    activeRecoveryController?.abort();
    replaceMissions(missionsRef.current.map((candidate) =>
      candidate.id === missionId
        ? { ...candidate, detailAvailable: false, manageable: false, runnable: false }
        : candidate
    ));
    const nextDetails = { ...detailsRef.current };
    delete nextDetails[missionId];
    replaceDetails(nextDetails);
    setDetailLoading(false);
    setCreating(false);
    if (selectedIdRef.current === missionId) {
      setSelectedTaskId("");
      setShowTaskCreate(false);
      setCreatingTask(false);
      setMutatingTaskId("");
      setTaskActionError(undefined);
    }
  }, [replaceDetails, replaceMissions]);

  const loadWorkspace = useCallback(async () => {
    if (!sessionOwnerKey) return;
    listController.current?.abort();
    const controller = new AbortController();
    const requestGeneration = ++listGeneration.current;
    listController.current = controller;
    clearRowActionability();
    setCapabilities([]);
    setShowLoading(false);
    replaceLoading(true);
    setError(undefined);
    try {
      const [missionPayload, capabilityPayload] = await Promise.all([
        readJson("/api/missions?ownerScope=readable&limit=50", {
          signal: controller.signal,
        }),
        readJson("/api/capabilities?view=catalog&limit=50", {
          signal: controller.signal,
        }),
      ]);
      if (!missionRequestIsCurrent({
        currentController: listController.current,
        requestController: controller,
        currentGeneration: listGeneration.current,
        requestGeneration,
      })) return;
      if (!missionCollectionIsReadable(
        record(missionPayload.requestReadContracts).missions,
      )) {
        throw new Error("Mission ownership could not be verified.");
      }
      let nextMissions = normalizeMissionSummaries(missionPayload.missions);
      if (!nextMissions) {
        throw new Error("Missions returned an unsupported response.");
      }
      let reprovedDetail: BoardMissionDetail | undefined;
      let routeMissionMissing = false;
      const routeMissionId = missionIdFromPath(pathname);
      if (missionNeedsDeepExactReproof(nextMissions, routeMissionId)) {
        const detailRequest = ++detailRequestGeneration.current;
        try {
          const detailPayload = await readJson(
            `/api/missions/${encodeURIComponent(routeMissionId)}`,
            { signal: controller.signal },
          );
          if (!missionRequestIsCurrent({
            currentController: listController.current,
            requestController: controller,
            currentGeneration: listGeneration.current,
            requestGeneration,
          }) || !missionDetailRequestIsCurrent(
            detailRequestGeneration.current,
            detailRequest,
          )) return;
          const normalizedDetail = normalizeMissionDetail(detailPayload, routeMissionId);
          if (!normalizedDetail || normalizedDetail.mission.detailAvailable !== true) {
            throw new MissionDetailContractError();
          }
          reprovedDetail = normalizedDetail as BoardMissionDetail;
          nextMissions = [
            normalizedDetail.mission,
            ...nextMissions.filter((mission) => mission.id !== routeMissionId),
          ];
        } catch (detailError) {
          if (detailError instanceof ApiRequestError && detailError.status === 404) {
            routeMissionMissing = true;
          } else {
            throw detailError;
          }
        }
      }
      const nextCapabilities = Array.isArray(capabilityPayload.capabilities)
        ? capabilityPayload.capabilities as CapabilityDescriptor[]
        : [];
      if (!missionRequestIsCurrent({
        currentController: listController.current,
        requestController: controller,
        currentGeneration: listGeneration.current,
        requestGeneration,
      })) return;
      const currentSelectedId = selectedIdRef.current;
      const routeResolution = missionRouteAfterReproof(
        nextMissions,
        routeMissionId,
        baseSelectionRef.current || currentSelectedId,
        routeMissionMissing,
      );
      if (routeResolution.replacePath) {
        replaceMissionHistory(routeResolution.replacePath);
      }
      replaceMissions(nextMissions);
      replaceDetails(reprovedDetail
        ? { [reprovedDetail.mission.id]: reprovedDetail }
        : {});
      replaceMissionReadContract("readable_v1");
      setCapabilities(nextCapabilities);
      const nextSelectedId = routeResolution.selectedId;
      selectedIdRef.current = nextSelectedId;
      setSelectedId(nextSelectedId);
      baseSelectionRef.current = missionBaseSelection(
        nextMissions,
        baseSelectionRef.current,
        nextSelectedId,
      );
      lastVerifiedOwnerKey.current = sessionOwnerKey;
      setError(routeMissionMissing
        ? "This mission is no longer available."
        : undefined);
    } catch (loadError) {
      if (!missionRequestIsCurrent({
        currentController: listController.current,
        requestController: controller,
        currentGeneration: listGeneration.current,
        requestGeneration,
      })) return;
      lastVerifiedOwnerKey.current = undefined;
      setError(friendlyMessage(loadError, "load"));
    } finally {
      if (missionRequestIsCurrent({
        currentController: listController.current,
        requestController: controller,
        currentGeneration: listGeneration.current,
        requestGeneration,
      })) {
        listController.current = null;
        replaceLoading(false);
      }
    }
  }, [clearRowActionability, pathname, replaceDetails, replaceLoading, replaceMissionReadContract, replaceMissions, sessionOwnerKey]);

  useEffect(() => {
    const routeMissionId = missionIdFromPath(pathname);
    const nextId = missionRouteSelection(
      missions,
      routeMissionId,
      baseSelectionRef.current,
    );
    const selectionChanged = selectedIdRef.current !== nextId;
    if (selectionChanged) {
      detailGeneration.current += 1;
      detailRequestGeneration.current += 1;
      const activeDetailController = detailController.current;
      detailController.current = null;
      activeDetailController?.abort();
      eventGeneration.current += 1;
      const activeEventController = eventController.current;
      eventController.current = null;
      activeEventController?.abort();
      mutationGeneration.current += 1;
      const activeRecoveryController = mutationRecoveryController.current;
      mutationRecoveryController.current = null;
      activeRecoveryController?.abort();
      setDetailLoading(false);
      setSelectedTaskId("");
      setShowTaskCreate(false);
      setCreatingTask(false);
      setMutatingTaskId("");
      setTaskActionError(undefined);
    }
    selectedIdRef.current = nextId;
    setSelectedId((current) => current === nextId ? current : nextId);
    if (selectionChanged) setError(undefined);
  }, [missions, pathname]);

  useEffect(() => {
    const tick = () => setAsOf(Date.now());
    const timer = window.setInterval(tick, 60_000);
    tick();
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!loading) return;
    const timer = window.setTimeout(() => setShowLoading(true), 350);
    return () => window.clearTimeout(timer);
  }, [loading]);

  useEffect(() => {
    if (sessionStatus !== "ready" || !available || !sessionOwnerKey) {
      listGeneration.current += 1;
      const activeListController = listController.current;
      listController.current = null;
      activeListController?.abort();
      lastVerifiedOwnerKey.current = undefined;
      clearRowActionability();
      replaceLoading(false);
      return;
    }
    if (
      lastVerifiedOwnerKey.current === sessionOwnerKey &&
      missionCollectionIsReadable(missionReadContractRef.current)
    ) return;
    void loadWorkspace();
    return () => {
      const activeListController = listController.current;
      listController.current = null;
      activeListController?.abort();
    };
  }, [available, clearRowActionability, loadWorkspace, replaceLoading, sessionOwnerKey, sessionStatus]);

  useEffect(() => {
    if (!available || sessionStatus !== "ready") return;
    const controller = new AbortController();
    async function loadAgents() {
      try {
        const payload = await readJson("/api/agents?ownerScope=readable", { signal: controller.signal });
        if (!controller.signal.aborted) setAgents(agentOptions(payload));
      } catch {
        // Assignment remains optional when the agent catalog is unavailable.
      }
    }
    void loadAgents();
    return () => controller.abort();
  }, [available, sessionStatus]);

  useEffect(() => () => {
    listGeneration.current += 1;
    detailGeneration.current += 1;
    detailRequestGeneration.current += 1;
    eventGeneration.current += 1;
    mutationGeneration.current += 1;
    listController.current?.abort();
    detailController.current?.abort();
    eventController.current?.abort();
    mutationRecoveryController.current?.abort();
  }, []);

  useEffect(() => {
    const mission = missions.find((candidate) => candidate.id === selectedId);
    if (
      !available ||
      sessionStatus !== "ready" ||
      !selectedId ||
      missionSelectionMode(mission, missionReadContract, loading) !== "exact" ||
      details[selectedId]
    ) {
      const activeController = detailController.current;
      detailController.current = null;
      activeController?.abort();
      setDetailLoading(false);
      return;
    }
    detailController.current?.abort();
    const controller = new AbortController();
    const requestGeneration = ++detailGeneration.current;
    const detailRequest = ++detailRequestGeneration.current;
    const missionId = selectedId;
    detailController.current = controller;
    async function loadDetail() {
      setDetailLoading(true);
      try {
        const payload = await readJson(`/api/missions/${encodeURIComponent(missionId)}`, {
          signal: controller.signal,
        });
        if (!missionRequestIsCurrent({
          currentController: detailController.current,
          requestController: controller,
          currentGeneration: detailGeneration.current,
          requestGeneration,
        }) ||
          !missionDetailRequestIsCurrent(detailRequestGeneration.current, detailRequest) ||
          selectedIdRef.current !== missionId) return;
        const detail = normalizeMissionDetail(payload, missionId);
        if (!detail) throw new MissionDetailContractError();
        updateDetail(detail as BoardMissionDetail, missionId);
      } catch (loadError) {
        if (!missionRequestIsCurrent({
          currentController: detailController.current,
          requestController: controller,
          currentGeneration: detailGeneration.current,
          requestGeneration,
        }) ||
          !missionDetailRequestIsCurrent(detailRequestGeneration.current, detailRequest) ||
          selectedIdRef.current !== missionId) return;
        const status = loadError instanceof ApiRequestError
          ? loadError.status
          : undefined;
        if (missionFailureClearsCollection(status)) {
          clearRowActionability();
        } else {
          invalidateMissionRow(missionId);
        }
        setError(loadError instanceof MissionDetailContractError
          ? "Mission detail returned an unsupported response."
          : friendlyMessage(loadError, "load"));
      } finally {
        if (missionRequestIsCurrent({
          currentController: detailController.current,
          requestController: controller,
          currentGeneration: detailGeneration.current,
          requestGeneration,
        })) {
          detailController.current = null;
          setDetailLoading(false);
        }
      }
    }
    void loadDetail();
    return () => {
      controller.abort();
      if (detailController.current === controller) {
        detailController.current = null;
        setDetailLoading(false);
      }
    };
  }, [available, clearRowActionability, details, invalidateMissionRow, loading, missionReadContract, missions, selectedId, sessionStatus]);

  useEffect(() => {
    if (
      !available ||
      sessionStatus !== "ready" ||
      !selectedId ||
      selectionMode !== "exact" ||
      !selectedMissionStatus ||
      !["queued", "running", "waiting"].includes(selectedMissionStatus)
    ) return;
    const missionId = selectedId;
    const requestGeneration = ++eventGeneration.current;
    let stopped = false;
    let inFlight = false;
    let cursor = safeInitialDetail?.mission.id === missionId ? initialEventCursor : 0;
    let visibleStatus = detailsRef.current[missionId]?.mission.status;
    let visibleUpdatedAt = detailsRef.current[missionId]?.mission.updatedAt;
    let consecutiveFailures = 0;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const requestStillAllowed = () => {
      const currentMission = missionsRef.current.find((mission) => mission.id === missionId);
      return !stopped &&
        eventGeneration.current === requestGeneration &&
        selectedIdRef.current === missionId &&
        missionSelectionMode(
          currentMission,
          missionReadContractRef.current,
          loadingRef.current,
        ) === "exact";
    };
    const schedule = () => {
      if (!requestStillAllowed() || document.visibilityState === "hidden") return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => void pollMissionEvents(), missionEventPollDelay(consecutiveFailures));
    };
    const pollMissionEvents = async () => {
      timer = undefined;
      if (!requestStillAllowed() || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      controller = new AbortController();
      eventController.current = controller;
      try {
        const payload = await readJson(`/api/missions/${encodeURIComponent(missionId)}/events?afterSeq=${cursor}&limit=25`, { signal: controller.signal });
        if (!requestStillAllowed() || controller.signal.aborted) return;
        const events = Array.isArray(payload.events) ? payload.events : [];
        const nextCursor = missionEventCursor(payload.cursor, cursor);
        const projection = missionEventProjection(payload.mission);
        const changed = Boolean(projection && (!visibleStatus || projection.status !== visibleStatus || projection.updatedAt !== visibleUpdatedAt));
        if (events.length > 0 || changed) {
          const detailRequest = ++detailRequestGeneration.current;
          const detailPayload = await readJson(`/api/missions/${encodeURIComponent(missionId)}`, { signal: controller.signal });
          if (
            !requestStillAllowed() ||
            controller.signal.aborted ||
            !missionDetailRequestIsCurrent(detailRequestGeneration.current, detailRequest)
          ) return;
          const detail = normalizeMissionDetail(detailPayload, missionId);
          if (!detail) throw new MissionDetailContractError();
          if (!updateDetail(detail as BoardMissionDetail, missionId)) return;
          visibleStatus = detail.mission.status;
          visibleUpdatedAt = detail.mission.updatedAt;
        }
        cursor = nextCursor;
        consecutiveFailures = 0;
      } catch (pollError) {
        if (!controller.signal.aborted && requestStillAllowed()) {
          const status = pollError instanceof ApiRequestError
            ? pollError.status
            : undefined;
          const invalidDetail = pollError instanceof MissionDetailContractError;
          if (missionEventFailureClosesRow({ status, invalidDetail })) {
            if (missionFailureClearsCollection(status)) {
              clearRowActionability();
            } else {
              invalidateMissionRow(missionId);
            }
            setError(invalidDetail
              ? "Mission detail returned an unsupported response."
              : friendlyMessage(pollError, "load"));
          } else {
            consecutiveFailures += 1;
          }
        }
      } finally {
        if (eventController.current === controller) eventController.current = null;
        inFlight = false;
        schedule();
      }
    };
    const wake = () => {
      if (!requestStillAllowed() || inFlight || document.visibilityState === "hidden") return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      void pollMissionEvents();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        if (timer !== undefined) window.clearTimeout(timer);
        timer = undefined;
        controller?.abort();
        return;
      }
      wake();
    };
    wake();
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      stopped = true;
      eventGeneration.current += 1;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
      if (eventController.current === controller) eventController.current = null;
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [available, clearRowActionability, initialEventCursor, invalidateMissionRow, safeInitialDetail?.mission.id, selectedId, selectedMissionStatus, selectionMode, sessionStatus]);

  const visibleMissions = useMemo(() => missions.filter((mission) => showArchived || mission.status !== "archived"), [missions, showArchived]);
  const tasks = useMemo(() => selectedDetail?.tasks || [], [selectedDetail]);
  const agentNameMap = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);
  const filteredTasks = useMemo(() => tasks.filter((task) => {
    const column = boardColumnForTask(task, tasks);
    const query = search.trim().toLowerCase();
    if (query && !`${task.title} ${task.instructions} ${task.definitionOfDone}`.toLowerCase().includes(query)) return false;
    if (assigneeFilter !== "all" && taskAssigneeId(task) !== assigneeFilter) return false;
    if (taskFilter === "open" && column === "done") return false;
    if (taskFilter === "attention" && !["needs-you", "review", "waiting"].includes(column)) return false;
    if (taskFilter === "done" && column !== "done") return false;
    return true;
  }), [assigneeFilter, search, taskFilter, tasks]);
  const groupedTasks = useMemo(() => new Map(BOARD_COLUMNS.map((column) => [column.id, filteredTasks.filter((task) => boardColumnForTask(task, tasks) === column.id)])), [filteredTasks, tasks]);
  const workingCount = tasks.filter((task) => boardColumnForTask(task, tasks) === "working").length;
  const attentionCount = tasks.filter((task) => ["needs-you", "review", "waiting"].includes(boardColumnForTask(task, tasks))).length;
  const doneCount = tasks.filter((task) => boardColumnForTask(task, tasks) === "done").length;

  function updateDetail(detail: BoardMissionDetail, expectedId: string) {
    if (!missionDetailHasExpectedId(detail, expectedId)) return false;
    const normalizedMission = normalizeMissionSummary(detail.mission);
    if (normalizedMission?.id !== expectedId) return false;
    const currentMission = missionsRef.current.find((mission) => mission.id === expectedId);
    if (
      !currentMission ||
      missionSelectionMode(
        currentMission,
        missionReadContractRef.current,
        loadingRef.current,
      ) !== "exact"
    ) return false;
    const currentDetail = detailsRef.current[expectedId];
    if (
      currentDetail &&
      Date.parse(detail.mission.updatedAt) < Date.parse(currentDetail.mission.updatedAt)
    ) return false;
    const mergedDetail: BoardMissionDetail = {
      ...detail,
      mission: {
        ...normalizedMission,
        detailAvailable: currentMission.detailAvailable,
        manageable: currentMission.manageable,
        runnable: currentMission.runnable,
      },
    };
    replaceDetails({ ...detailsRef.current, [expectedId]: mergedDetail });
    replaceMissions(missionsRef.current.map((mission) =>
      mission.id === expectedId ? mergedDetail.mission : mission
    ));
    return true;
  }

  async function refreshDetail(
    missionId: string,
    requestGeneration: number,
  ) {
    const currentMission = missionsRef.current.find((mission) => mission.id === missionId);
    if (
      mutationGeneration.current !== requestGeneration ||
      missionSelectionMode(
        currentMission,
        missionReadContractRef.current,
        loadingRef.current,
      ) !== "exact"
    ) return undefined;
    mutationRecoveryController.current?.abort();
    const controller = new AbortController();
    const detailRequest = ++detailRequestGeneration.current;
    mutationRecoveryController.current = controller;
    try {
      const payload = await readJson(`/api/missions/${encodeURIComponent(missionId)}`, {
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        mutationGeneration.current !== requestGeneration ||
        !missionDetailRequestIsCurrent(detailRequestGeneration.current, detailRequest) ||
        selectedIdRef.current !== missionId
      ) return undefined;
      const detail = normalizeMissionDetail(payload, missionId);
      if (!detail) {
        invalidateMissionRow(missionId);
        setError("Mission detail returned an unsupported response.");
        return undefined;
      }
      return updateDetail(detail as BoardMissionDetail, missionId)
        ? (detail as BoardMissionDetail)
        : undefined;
    } catch (recoveryError) {
      const status = recoveryError instanceof ApiRequestError
        ? recoveryError.status
        : undefined;
      if (
        !controller.signal.aborted &&
        mutationGeneration.current === requestGeneration &&
        missionDetailRequestIsCurrent(detailRequestGeneration.current, detailRequest) &&
        selectedIdRef.current === missionId &&
        missionEventFailureClosesRow({ status })
      ) {
        if (missionFailureClearsCollection(status)) {
          clearRowActionability();
        } else {
          invalidateMissionRow(missionId);
        }
        setError(friendlyMessage(recoveryError, "load"));
      }
      throw recoveryError;
    } finally {
      if (mutationRecoveryController.current === controller) {
        mutationRecoveryController.current = null;
      }
    }
  }

  function selectMission(id: string) {
    detailGeneration.current += 1;
    detailRequestGeneration.current += 1;
    const activeDetailController = detailController.current;
    detailController.current = null;
    activeDetailController?.abort();
    eventGeneration.current += 1;
    const activeEventController = eventController.current;
    eventController.current = null;
    activeEventController?.abort();
    mutationGeneration.current += 1;
    const activeRecoveryController = mutationRecoveryController.current;
    mutationRecoveryController.current = null;
    activeRecoveryController?.abort();
    setDetailLoading(false);
    selectedIdRef.current = id;
    setSelectedTaskId("");
    setTaskActionError(undefined);
    setShowTaskCreate(false);
    setCreatingTask(false);
    setMutatingTaskId("");
    setSelectedId(id);
    setError(undefined);
    pushMissionHistory(id);
  }

  function currentCreateActionBlocked() {
    return missionCreateActionBlocked({
      contract: missionReadContractRef.current,
      loading: loadingRef.current,
      permissionBlocked: permissionMessage(session, sessionStatus, "run.agent"),
    });
  }

  function currentTaskActionBlocked(missionId: string) {
    return missionTaskActionBlocked({
      mission: missionsRef.current.find((mission) => mission.id === missionId),
      contract: missionReadContractRef.current,
      loading: loadingRef.current,
      permissionBlocked: permissionMessage(session, sessionStatus, "manage.workflow"),
    });
  }

  function currentCommandActionBlocked(missionId: string) {
    return missionCommandActionBlocked({
      mission: missionsRef.current.find((mission) => mission.id === missionId),
      contract: missionReadContractRef.current,
      loading: loadingRef.current,
      permissionBlocked: permissionMessage(session, sessionStatus, "run.agent"),
    });
  }

  async function createMission(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || !objective.trim()) return;
    const blockedReason = currentCreateActionBlocked();
    if (blockedReason) {
      setError(blockedReason);
      return;
    }
    const requestGeneration = ++mutationGeneration.current;
    mutationRecoveryController.current?.abort();
    mutationRecoveryController.current = null;
    setCreating(true);
    setError(undefined);
    try {
      const payload = await readJson("/api/missions", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: title.trim(), objective: objective.trim(), priority }),
      });
      if (mutationGeneration.current !== requestGeneration) return;
      const mission = normalizeMissionSummary(payload.mission);
      if (!mission) throw new Error("Mission creation returned an unsupported response.");
      replaceMissions([mission, ...missionsRef.current.filter((item) => item.id !== mission.id)]);
      selectedIdRef.current = mission.id;
      setSelectedTaskId("");
      setTaskActionError(undefined);
      setShowTaskCreate(false);
      setSelectedId(mission.id);
      setTitle(""); setObjective(""); setPriority("normal"); setShowCreate(false);
      setAnnouncement(`${mission.title} was created as a draft mission.`);
      pushMissionHistory(mission.id);
    } catch (createError) {
      if (mutationGeneration.current === requestGeneration) {
        setError(friendlyMessage(createError, "create"));
      }
    } finally {
      if (mutationGeneration.current === requestGeneration) setCreating(false);
    }
  }

  async function createTask(input: NewTaskInput) {
    const missionId = selectedIdRef.current;
    const blockedReason = currentTaskActionBlocked(missionId);
    if (!missionId || blockedReason) {
      if (blockedReason) setTaskActionError(blockedReason);
      return;
    }
    const requestGeneration = ++mutationGeneration.current;
    mutationRecoveryController.current?.abort();
    mutationRecoveryController.current = null;
    setCreatingTask(true); setTaskActionError(undefined);
    try {
      const payload = await readJson(`/api/missions/${encodeURIComponent(missionId)}/tasks`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: input.title, instructions: input.instructions, definitionOfDone: input.definitionOfDone, priority: input.priority, status: input.boardStage === "inbox" ? "triage" : "pending", assigneeId: input.assigneeId || undefined, reviewRequired: input.reviewRequired }),
      });
      if (mutationGeneration.current !== requestGeneration) return;
      const detail = await refreshDetail(missionId, requestGeneration);
      if (mutationGeneration.current !== requestGeneration) return;
      const taskId = taskIdFromMutation(payload);
      if (taskId && detail?.tasks.some((task) => task.id === taskId)) setSelectedTaskId(taskId);
      setShowTaskCreate(false);
      setAnnouncement(`${input.title} was added to ${input.boardStage === "inbox" ? "Inbox" : "Ready"}.`);
    } catch (createError) {
      if (mutationGeneration.current === requestGeneration) {
        setTaskActionError(friendlyMessage(createError, "create"));
      }
    } finally {
      if (mutationGeneration.current === requestGeneration) setCreatingTask(false);
    }
  }

  async function patchTask(taskId: string, input: Record<string, unknown>, successMessage: string) {
    const missionId = selectedIdRef.current;
    const blockedReason = currentTaskActionBlocked(missionId);
    const taskIsCurrent = detailsRef.current[missionId]?.tasks.some((task) => task.id === taskId);
    if (!missionId || blockedReason || !taskIsCurrent) {
      setTaskActionError(blockedReason || "This task is no longer available in the current mission.");
      return;
    }
    const requestGeneration = ++mutationGeneration.current;
    mutationRecoveryController.current?.abort();
    mutationRecoveryController.current = null;
    setMutatingTaskId(taskId); setTaskActionError(undefined);
    try {
      await readJson(`/api/missions/${encodeURIComponent(missionId)}/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
      });
      if (mutationGeneration.current !== requestGeneration) return;
      await refreshDetail(missionId, requestGeneration);
      if (mutationGeneration.current === requestGeneration) setAnnouncement(successMessage);
    } catch (mutationError) {
      if (mutationGeneration.current === requestGeneration) {
        setTaskActionError(friendlyMessage(mutationError, "update"));
      }
    } finally {
      if (mutationGeneration.current === requestGeneration) setMutatingTaskId("");
    }
  }

  async function addComment(taskId: string, body: string) {
    const missionId = selectedIdRef.current;
    const blockedReason = currentTaskActionBlocked(missionId);
    const taskIsCurrent = detailsRef.current[missionId]?.tasks.some((task) => task.id === taskId);
    if (!missionId || !body.trim() || blockedReason || !taskIsCurrent) {
      if (blockedReason || !taskIsCurrent) {
        setTaskActionError(blockedReason || "This task is no longer available in the current mission.");
      }
      return false;
    }
    const requestGeneration = ++mutationGeneration.current;
    mutationRecoveryController.current?.abort();
    mutationRecoveryController.current = null;
    setMutatingTaskId(taskId); setTaskActionError(undefined);
    try {
      await readJson(`/api/missions/${encodeURIComponent(missionId)}/tasks/${encodeURIComponent(taskId)}/comments`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: body.trim() }),
      });
      if (mutationGeneration.current !== requestGeneration) return false;
      await refreshDetail(missionId, requestGeneration);
      if (mutationGeneration.current !== requestGeneration) return false;
      setAnnouncement("Comment added to the task.");
      return true;
    } catch (commentError) {
      if (mutationGeneration.current === requestGeneration) {
        setTaskActionError(friendlyMessage(commentError, "update"));
      }
      return false;
    } finally {
      if (mutationGeneration.current === requestGeneration) setMutatingTaskId("");
    }
  }

  async function reviewTask(taskId: string, action: ReviewAction, note = "") {
    const missionId = selectedIdRef.current;
    const blockedReason = currentTaskActionBlocked(missionId);
    const taskIsCurrent = detailsRef.current[missionId]?.tasks.some((task) => task.id === taskId);
    if (!missionId || blockedReason || !taskIsCurrent) {
      setTaskActionError(blockedReason || "This task is no longer available in the current mission.");
      return;
    }
    const requestGeneration = ++mutationGeneration.current;
    mutationRecoveryController.current?.abort();
    mutationRecoveryController.current = null;
    setMutatingTaskId(taskId); setTaskActionError(undefined);
    try {
      await readJson(`/api/missions/${encodeURIComponent(missionId)}/tasks/${encodeURIComponent(taskId)}/review`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          ...(action === "request_changes" ? { reason: note.trim() } : note.trim() ? { summary: note.trim() } : {}),
        }),
      });
      if (mutationGeneration.current !== requestGeneration) return;
      await refreshDetail(missionId, requestGeneration);
      if (mutationGeneration.current === requestGeneration) setAnnouncement(reviewActionLabel(action));
    } catch (reviewError) {
      if (mutationGeneration.current === requestGeneration) {
        setTaskActionError(friendlyMessage(reviewError, "update"));
      }
    } finally {
      if (mutationGeneration.current === requestGeneration) setMutatingTaskId("");
    }
  }

  return (
    <section className={styles.shell} aria-busy={workspaceLoading || detailLoading}>
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
      <header className={styles.header}>
        <div className={styles.titleGroup}>
          <div className={styles.titleLine}><span className={styles.titleIcon}><SquareKanban size={18} aria-hidden="true" /></span><div className={styles.titleCopy}><span className={styles.eyebrow}>Connected work</span><h1>Missions</h1></div></div>
          <p>Move durable outcomes through linked tasks, agents, decisions, and evidence.</p>
        </div>
        <div className={styles.headerActions}>
          <Link href="/app/connectors" title="Manage connected capabilities"><Zap size={14} aria-hidden="true" /> {capabilities.length} tools</Link>
          <button type="button" className={styles.secondaryButton} onClick={() => setShowCreate(true)} disabled={Boolean(createActionBlocked)} title={createActionBlocked}><Plus size={14} aria-hidden="true" /> Mission</button>
          {selectionMode === "exact" ? <button type="button" className={styles.primaryButton} onClick={() => setShowTaskCreate(true)} disabled={Boolean(taskActionBlocked)} title={taskActionBlocked}><Plus size={14} aria-hidden="true" /> Task</button> : null}
        </div>
      </header>

      {displayError ? <div className={styles.error} role="alert"><TriangleAlert size={15} aria-hidden="true" /><span>{displayError}</span>{sessionStatus === "ready" && !available ? <Link href="/login">Sign in</Link> : <button type="button" onClick={() => sessionStatus === "error" ? void refreshSession() : void loadWorkspace()}>Try again</button>}</div> : null}

      <div className={clsx(styles.workspace, railCollapsed && styles.workspaceRailCollapsed)}>
        <aside className={clsx(styles.rail, railCollapsed && styles.railCollapsed)} aria-label="Mission selector">
          <div className={styles.railHeading}>
            <span className={styles.railLabel}>{railCollapsed ? "" : <><b>Mission library</b><small>{visibleMissions.length}</small></>}</span>
            <button type="button" onClick={() => setRailCollapsed((current) => !current)} aria-label={railCollapsed ? "Expand mission selector" : "Collapse mission selector"} title={railCollapsed ? "Expand missions" : "Collapse missions"}>
              {railCollapsed ? <PanelLeftOpen size={15} aria-hidden="true" /> : <PanelLeftClose size={15} aria-hidden="true" />}
            </button>
          </div>
          <div className={styles.railList}>
            {workspaceLoading ? (showLoading ? <MissionListSkeleton /> : <div className={styles.loadingReserve} aria-hidden="true" />) : visibleMissions.length ? visibleMissions.map((mission) => (
              <button key={mission.id} type="button" aria-pressed={selectedId === mission.id} aria-label={railCollapsed ? `${mission.title}, ${missionStatusLabel(mission.status)}` : undefined} title={railCollapsed ? mission.title : undefined} className={clsx(styles.missionItem, selectedId === mission.id && styles.missionItemSelected)} onClick={() => selectMission(mission.id)}>
                <span className={clsx(styles.statusDot, statusToneClass(mission.status))} aria-hidden="true" />
                <span className={styles.missionItemCopy}><strong>{mission.title}</strong><small>{missionStatusLabel(mission.status)} · {relativeTime(mission.updatedAt, asOf)}</small></span>
                <ChevronRight className={styles.missionChevron} size={14} aria-hidden="true" />
              </button>
            )) : <div className={styles.emptyRail}><Inbox size={18} aria-hidden="true" />{!railCollapsed ? <><p>No missions yet.</p><button type="button" onClick={() => setShowCreate(true)} disabled={Boolean(createActionBlocked)} title={createActionBlocked}>Create one</button></> : null}</div>}
          </div>
          <label className={styles.archiveToggle} title="Include archived missions"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.currentTarget.checked)} /><Archive size={13} aria-hidden="true" />{!railCollapsed ? <span>Show archived</span> : null}</label>
        </aside>

        <main className={styles.main}>
          {selectedMission && selectionMode === "exact" ? <>
            <section className={styles.missionHeader} aria-labelledby="mission-title">
              <div className={styles.missionIdentity}>
                <div className={styles.missionMeta}><span className={clsx(styles.missionStatus, statusToneClass(selectedMission.status))}>{missionStatusLabel(selectedMission.status)}</span><span>{selectedMission.priority} priority</span><span>Updated {relativeTime(selectedMission.updatedAt, asOf)}</span></div>
                <h2 id="mission-title">{selectedMission.title}</h2><p>{selectedMission.objective}</p>
              </div>
              <div className={styles.missionLinks}>{!commandActionBlocked ? <Link href={talkHref(selectedMission)} onClick={(event) => { const blockedReason = currentCommandActionBlocked(selectedMission.id); if (blockedReason) { event.preventDefault(); setError(blockedReason); } }}><Bot size={14} aria-hidden="true" /> Continue in Command</Link> : null}<Link href="/app/approvals"><ShieldCheck size={14} aria-hidden="true" /> Approvals</Link></div>
            </section>
            <div className={styles.metrics} aria-label="Mission task overview"><span><strong>{tasks.length}</strong> tasks</span><span><strong>{workingCount}</strong> working</span><span><strong>{attentionCount}</strong> need attention</span><span><strong>{doneCount}</strong> done</span><span className={styles.ledgerSignal}><i aria-hidden="true" /> Ledger live</span></div>
            <div className={styles.toolbar}>
              <label className={styles.searchField}><span className="sr-only">Search tasks</span><Search size={14} aria-hidden="true" /><input value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="Search tasks" />{search ? <button type="button" onClick={() => setSearch("")} aria-label="Clear search"><X size={13} aria-hidden="true" /></button> : null}</label>
              <label className={styles.filterField}><UserRound size={13} aria-hidden="true" /><span className="sr-only">Filter by assignee</span><select value={assigneeFilter} onChange={(event) => setAssigneeFilter(event.currentTarget.value)}><option value="all">All agents</option><option value="unassigned">Unassigned</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
              <label className={styles.filterField}><CircleDot size={13} aria-hidden="true" /><span className="sr-only">Filter by task state</span><select value={taskFilter} onChange={(event) => setTaskFilter(event.currentTarget.value as TaskFilter)}><option value="all">All states</option><option value="open">Open work</option><option value="attention">Needs attention</option><option value="done">Done</option></select></label>
              <div className={styles.viewSwitch} role="group" aria-label="Mission view"><ViewButton active={view === "board"} label="Board" onClick={() => setView("board")} icon={<Columns3 size={14} />} /><ViewButton active={view === "canvas"} label="Canvas" onClick={() => setView("canvas")} icon={<GitBranch size={14} />} /><ViewButton active={view === "list"} label="List" onClick={() => setView("list")} icon={<LayoutList size={14} />} /></div>
              <button type="button" className={styles.toolbarAdd} onClick={() => setShowTaskCreate(true)} disabled={Boolean(taskActionBlocked)} title={taskActionBlocked}><Plus size={14} aria-hidden="true" /> New task</button>
            </div>
            {detailLoading && !selectedDetail ? <CanvasSkeleton /> : <div className={styles.viewFrame} key={view}>
              {view === "board" ? <TaskBoard columns={BOARD_COLUMNS} groupedTasks={groupedTasks} allTasks={tasks} detail={selectedDetail} agents={agentNameMap} asOf={asOf} mobileColumn={mobileColumn} onMobileColumnChange={setMobileColumn} onSelectTask={(task) => setSelectedTaskId(task.id)} onCreateTask={() => setShowTaskCreate(true)} createDisabledReason={taskActionBlocked} />
                : view === "canvas" ? <TaskCanvas tasks={filteredTasks} allTasks={tasks} agents={agentNameMap} onSelectTask={(task) => setSelectedTaskId(task.id)} />
                  : <TaskList tasks={filteredTasks} allTasks={tasks} detail={selectedDetail} agents={agentNameMap} asOf={asOf} onSelectTask={(task) => setSelectedTaskId(task.id)} />}
            </div>}
          </> : selectedMission ? <MissionSummaryOnly mission={selectedMission} mode={summarySelectionMode} asOf={asOf} /> : workspaceLoading ? (showLoading ? <CanvasSkeleton /> : <div className={styles.loadingReserve} aria-hidden="true" />) : <div className={styles.emptyCanvas}><Workflow size={28} aria-hidden="true" /><h2>Create a mission to organize durable work</h2><p>Each mission keeps tasks, agent attempts, approvals, and evidence connected.</p><button type="button" onClick={() => setShowCreate(true)} disabled={Boolean(createActionBlocked)} title={createActionBlocked}><Plus size={14} aria-hidden="true" /> New mission</button></div>}
        </main>
      </div>

      {showCreate && !createActionBlocked ? <MissionCreateDialog title={title} objective={objective} priority={priority} creating={creating} error={error} onTitleChange={setTitle} onObjectiveChange={setObjective} onPriorityChange={setPriority} onClose={() => setShowCreate(false)} onSubmit={createMission} /> : null}
      {showTaskCreate && selectedMission && !taskActionBlocked ? <TaskCreateDialog missionTitle={selectedMission.title} agents={agents} creating={creatingTask} error={taskActionError} onClose={() => { setShowTaskCreate(false); setTaskActionError(undefined); }} onCreate={createTask} /> : null}
      {selectedTask && selectedDetail ? <TaskDrawer key={`${selectedTask.id}:${selectedTask.updatedAt}`} task={selectedTask} allTasks={tasks} detail={selectedDetail} agents={agents} agentNames={agentNameMap} asOf={asOf} busy={mutatingTaskId === selectedTask.id} disabledReason={taskActionBlocked} error={taskActionError} onClose={() => { setSelectedTaskId(""); setTaskActionError(undefined); }} onSave={(input) => patchTask(selectedTask.id, { expectedUpdatedAt: selectedTask.updatedAt, ...input }, "Task details saved.")} onAction={(action) => patchTask(selectedTask.id, { expectedUpdatedAt: selectedTask.updatedAt, ...taskActionPatch(action, selectedTask) }, taskActionLabel(action))} onReview={(action, note) => reviewTask(selectedTask.id, action, note)} onComment={(body) => addComment(selectedTask.id, body)} /> : null}
    </section>
  );
}

export function MissionSummaryOnly({
  mission,
  mode,
  asOf = 0,
}: {
  mission: MissionSummaryView;
  mode: Exclude<MissionSelectionMode, "exact">;
  asOf?: number;
}) {
  const retained = mode === "retained";
  return <section aria-labelledby="mission-title" data-mission-surface="summary-only">
    <section className={styles.missionHeader}>
      <div className={styles.missionIdentity}>
        <div className={styles.missionMeta}><span className={clsx(styles.missionStatus, statusToneClass(mission.status))}>{missionStatusLabel(mission.status)}</span><span>{mission.priority} priority</span><span>Updated {relativeTime(mission.updatedAt, asOf)}</span></div>
        <h2 id="mission-title">{mission.title}</h2><p>{mission.objective}</p>
      </div>
    </section>
    <div className={styles.emptyCanvas}>
      <ShieldCheck size={28} aria-hidden="true" />
      <h3>{retained ? "Read-only retained mission" : "Mission access is being verified"}</h3>
      <p>{retained
        ? "This mission remains visible for continuity, but its task board, execution controls, and updates remain with its stored owner."
        : "The summary remains visible while current ownership is verified. Detail and action controls are unavailable until refresh succeeds."}</p>
    </div>
  </section>;
}

function ViewButton({ active, label, icon, onClick }: { active: boolean; label: string; icon: React.ReactNode; onClick: () => void }) {
  return <button type="button" className={active ? styles.viewButtonActive : undefined} aria-pressed={active} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function TaskBoard({ columns, groupedTasks, allTasks, detail, agents, asOf, mobileColumn, onMobileColumnChange, onSelectTask, onCreateTask, createDisabledReason }: {
  columns: BoardColumn[]; groupedTasks: Map<BoardColumnId, BoardTask[]>; allTasks: BoardTask[]; detail?: BoardMissionDetail; agents: Map<string, string>; asOf: number; mobileColumn: BoardColumnId; onMobileColumnChange: (column: BoardColumnId) => void; onSelectTask: (task: BoardTask) => void; onCreateTask: () => void; createDisabledReason?: string;
}) {
  return <section className={styles.boardRegion} aria-label="Task board">
    <label className={styles.mobileColumnPicker}><span>Board column</span><select value={mobileColumn} onChange={(event) => onMobileColumnChange(event.currentTarget.value as BoardColumnId)}>{columns.map((column) => <option key={column.id} value={column.id}>{column.title} ({groupedTasks.get(column.id)?.length || 0})</option>)}</select></label>
    <div className={styles.board}>{columns.map((column) => {
      const columnTasks = groupedTasks.get(column.id) || [];
      return <section key={column.id} className={styles.boardColumn} data-mobile-visible={column.id === mobileColumn} aria-labelledby={`column-${column.id}`}>
        <header className={styles.columnHeader}><span className={clsx(styles.columnMark, columnToneClass(column.id))} aria-hidden="true" /><div><h3 id={`column-${column.id}`}>{column.title}</h3><p>{column.description}</p></div><strong>{columnTasks.length}</strong></header>
        <div className={styles.columnTasks}>{columnTasks.map((task) => <TaskCard key={task.id} task={task} allTasks={allTasks} detail={detail} agents={agents} asOf={asOf} onSelect={() => onSelectTask(task)} />)}
          {!columnTasks.length ? <div className={styles.columnEmpty}><span>{column.id === "inbox" ? "Drop a rough task here to shape it." : `No tasks in ${column.title.toLowerCase()}.`}</span>{column.id === "inbox" ? <button type="button" onClick={onCreateTask} disabled={Boolean(createDisabledReason)} title={createDisabledReason}><Plus size={12} aria-hidden="true" /> Add task</button> : null}</div> : null}
        </div>
      </section>;
    })}</div>
  </section>;
}

function TaskCard({ task, allTasks, detail, agents, asOf, onSelect }: { task: BoardTask; allTasks: BoardTask[]; detail?: BoardMissionDetail; agents: Map<string, string>; asOf: number; onSelect: () => void }) {
  const dependency = dependencyProgress(task, allTasks);
  const attempts = attemptsForTask(detail, task.id);
  const comments = commentsForTask(detail, task);
  const evidence = artifactsForTask(detail, task.id).filter((artifact) => !isCommentArtifact(artifact));
  const assignee = taskAssigneeLabel(task, agents);
  const column = boardColumnForTask(task, allTasks);
  const retries = taskRetryCount(task, attempts.length);
  return <button type="button" className={styles.taskCard} onClick={onSelect} aria-label={`Open ${task.title}`}>
    <span className={styles.cardTopline}><span className={clsx(styles.priority, priorityClass(task.priority))}>{task.priority}</span><span className={styles.cardAge}>{relativeTime(task.updatedAt, asOf)}</span></span>
    <strong className={styles.cardTitle}>{task.title}</strong>
    {taskCue(task, column) ? <span className={clsx(styles.taskCue, cueClass(column))}>{taskCue(task, column)}</span> : null}
    <span className={styles.assignee}><span aria-hidden="true">{initials(assignee)}</span><b>{assignee}</b></span>
    <span className={styles.cardFooter}>{dependency.total ? <span title="Completed dependencies"><GitBranch size={12} aria-hidden="true" /> {dependency.done}/{dependency.total}</span> : null}{attempts.length ? <span title={`${attempts.length} attempts, ${retries} retries`}><RefreshCw size={12} aria-hidden="true" /> {attempts.length}a · {retries}r</span> : null}{comments.length ? <span title="Comments"><MessageSquare size={12} aria-hidden="true" /> {comments.length}</span> : null}{evidence.length ? <span title="Evidence"><Paperclip size={12} aria-hidden="true" /> {evidence.length}</span> : null}</span>
  </button>;
}

function TaskCanvas({ tasks, allTasks, agents, onSelectTask }: { tasks: BoardTask[]; allTasks: BoardTask[]; agents: Map<string, string>; onSelectTask: (task: BoardTask) => void }) {
  if (!tasks.length) return <FilteredEmpty icon={<GitBranch size={22} />} title="No tasks to map" body="Change the filters or add a task to build the dependency canvas." />;
  const graph = buildTaskGraph(tasks, allTasks);
  return <section className={styles.graphViewport} aria-label="Task dependency canvas">
    <div className={styles.graphLegend}><span><i /> Parent or dependency link</span><span>Left to right execution order</span></div>
    <div className={styles.graph} style={{ width: graph.width, height: graph.height }}>
      <svg className={styles.graphEdges} width={graph.width} height={graph.height} aria-hidden="true"><defs><marker id="mission-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" /></marker></defs>{graph.edges.map((edge) => <path key={`${edge.from}-${edge.to}`} d={edge.path} markerEnd="url(#mission-arrow)" />)}</svg>
      {graph.nodes.map((node) => { const assignee = taskAssigneeLabel(node.task, agents); const column = boardColumnForTask(node.task, allTasks); return <button key={node.task.id} type="button" className={styles.graphNode} style={{ left: node.x, top: node.y }} onClick={() => onSelectTask(node.task)}><span><i className={columnToneClass(column)} aria-hidden="true" />{boardColumnLabel(column)}</span><strong>{node.task.title}</strong><small>{assignee} · {node.task.priority}</small></button>; })}
    </div>
  </section>;
}

function TaskList({ tasks, allTasks, detail, agents, asOf, onSelectTask }: { tasks: BoardTask[]; allTasks: BoardTask[]; detail?: BoardMissionDetail; agents: Map<string, string>; asOf: number; onSelectTask: (task: BoardTask) => void }) {
  if (!tasks.length) return <FilteredEmpty icon={<LayoutList size={22} />} title="No matching tasks" body="Change the filters or add a task to this mission." />;
  return <div className={styles.listViewport}><table className={styles.taskTable}><thead><tr><th>Task</th><th>State</th><th>Assignee</th><th>Dependencies</th><th>Attempts</th><th>Updated</th></tr></thead><tbody>{tasks.map((task) => {
    const dependency = dependencyProgress(task, allTasks); const attempts = attemptsForTask(detail, task.id); const column = boardColumnForTask(task, allTasks);
    return <tr key={task.id}><td><button type="button" onClick={() => onSelectTask(task)}><strong>{task.title}</strong><small>{task.definitionOfDone || task.instructions || "Outcome not defined"}</small></button></td><td><span className={styles.tableState}><i className={columnToneClass(column)} aria-hidden="true" />{boardColumnLabel(column)}</span></td><td>{taskAssigneeLabel(task, agents)}</td><td>{dependency.total ? `${dependency.done} / ${dependency.total}` : "—"}</td><td>{attempts.length}</td><td>{relativeTime(task.updatedAt, asOf)}</td></tr>;
  })}</tbody></table></div>;
}

function FilteredEmpty({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return <div className={styles.filteredEmpty}>{icon}<strong>{title}</strong><p>{body}</p></div>;
}

function MissionCreateDialog({ title, objective, priority, creating, error, onTitleChange, onObjectiveChange, onPriorityChange, onClose, onSubmit }: {
  title: string; objective: string; priority: MissionSummaryView["priority"]; creating: boolean; error?: string; onTitleChange: (value: string) => void; onObjectiveChange: (value: string) => void; onPriorityChange: (value: MissionSummaryView["priority"]) => void; onClose: () => void; onSubmit: (event: React.FormEvent) => void;
}) {
  const closeRef = useDialogFocus(onClose);
  return <div className={styles.dialogBackdrop} onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="new-mission-title" onSubmit={onSubmit}>
    <header><div><p>Durable outcome</p><h2 id="new-mission-title">New mission</h2></div><button ref={closeRef} type="button" onClick={onClose} aria-label="Close"><X size={16} /></button></header>
    <label>Mission title<input value={title} onChange={(event) => onTitleChange(event.currentTarget.value)} maxLength={240} placeholder="Prepare the quarterly strategy" autoFocus /></label>
    <label>Observable outcome<textarea value={objective} onChange={(event) => onObjectiveChange(event.currentTarget.value)} maxLength={4000} rows={4} placeholder="Describe what must be true when the mission is done." /></label>
    <label>Priority<select value={priority} onChange={(event) => onPriorityChange(event.currentTarget.value as MissionSummaryView["priority"])}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label>
    {error ? <p className={styles.dialogError} role="alert">{error}</p> : null}
    <footer><button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={creating || !title.trim() || !objective.trim()}>{creating ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />} Create draft</button></footer>
  </form></div>;
}

type NewTaskInput = { title: string; instructions: string; definitionOfDone: string; priority: MissionSummaryView["priority"]; assigneeId: string; reviewRequired: boolean; boardStage: "inbox" | "ready" };

function TaskCreateDialog({ missionTitle, agents, creating, error, onClose, onCreate }: { missionTitle: string; agents: AgentOption[]; creating: boolean; error?: string; onClose: () => void; onCreate: (input: NewTaskInput) => void }) {
  const closeRef = useDialogFocus(onClose);
  const assignableAgents = agents.filter((agent) => agent.selectable);
  const [title, setTitle] = useState(""); const [instructions, setInstructions] = useState(""); const [definitionOfDone, setDefinitionOfDone] = useState("");
  const [priority, setPriority] = useState<MissionSummaryView["priority"]>("normal"); const [assigneeId, setAssigneeId] = useState(""); const [reviewRequired, setReviewRequired] = useState(true); const [boardStage, setBoardStage] = useState<"inbox" | "ready">("inbox");
  return <div className={styles.dialogBackdrop} onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className={clsx(styles.dialog, styles.taskCreateDialog)} role="dialog" aria-modal="true" aria-labelledby="new-task-title" onSubmit={(event) => { event.preventDefault(); void onCreate({ title: title.trim(), instructions: instructions.trim(), definitionOfDone: definitionOfDone.trim(), priority, assigneeId, reviewRequired, boardStage }); }}>
    <header><div><p>{missionTitle}</p><h2 id="new-task-title">New task</h2></div><button ref={closeRef} type="button" onClick={onClose} aria-label="Close"><X size={16} /></button></header>
    <label>Task title<input value={title} onChange={(event) => setTitle(event.currentTarget.value)} maxLength={240} placeholder="What needs to happen?" autoFocus /></label>
    <label>Working instructions<textarea value={instructions} onChange={(event) => setInstructions(event.currentTarget.value)} maxLength={8000} rows={4} placeholder="Useful context, constraints, and boundaries." /></label>
    <label>Definition of done<textarea value={definitionOfDone} onChange={(event) => setDefinitionOfDone(event.currentTarget.value)} maxLength={2000} rows={3} placeholder="The observable outcome and required evidence." /></label>
    <div className={styles.formGrid}><label>Start in<select value={boardStage} onChange={(event) => setBoardStage(event.currentTarget.value as "inbox" | "ready")}><option value="inbox">Inbox — shape first</option><option value="ready">Ready — clear to start</option></select></label><label>Priority<select value={priority} onChange={(event) => setPriority(event.currentTarget.value as MissionSummaryView["priority"])}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label><label>Assignee<select value={assigneeId} onChange={(event) => setAssigneeId(event.currentTarget.value)}><option value="">Unassigned</option>{assignableAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}{agent.role ? ` · ${agent.role}` : ""}</option>)}</select></label></div>
    <label className={styles.checkLabel}><input type="checkbox" checked={reviewRequired} onChange={(event) => setReviewRequired(event.currentTarget.checked)} /><span><strong>Require review</strong><small>Move to Review before this task can be accepted.</small></span></label>
    {error ? <p className={styles.dialogError} role="alert">{error}</p> : null}
    <footer><button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={creating || !title.trim() || !definitionOfDone.trim()}>{creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add task</button></footer>
  </form></div>;
}

type ReviewAction = "request_review" | "approve" | "request_changes";

function TaskDrawer({ task, allTasks, detail, agents, agentNames, asOf, busy, disabledReason, error, onClose, onSave, onAction, onReview, onComment }: {
  task: BoardTask; allTasks: BoardTask[]; detail: BoardMissionDetail; agents: AgentOption[]; agentNames: Map<string, string>; asOf: number; busy: boolean; disabledReason?: string; error?: string; onClose: () => void; onSave: (input: Record<string, unknown>) => void; onAction: (action: TaskAction) => void; onReview: (action: ReviewAction, note: string) => void; onComment: (body: string) => Promise<boolean>;
}) {
  const closeRef = useDialogFocus(onClose);
  const [title, setTitle] = useState(task.title); const [instructions, setInstructions] = useState(task.instructions); const [definitionOfDone, setDefinitionOfDone] = useState(task.definitionOfDone); const [priority, setPriority] = useState(task.priority);
  const originalAssigneeId = taskAssigneeId(task);
  const [assigneeId, setAssigneeId] = useState(originalAssigneeId === "unassigned" ? "" : originalAssigneeId); const [reviewRequired, setReviewRequired] = useState(taskReviewRequired(task)); const [blockerReason, setBlockerReason] = useState(taskBlockerReason(task)); const [dependencyIds, setDependencyIds] = useState(task.dependencyIds); const [comment, setComment] = useState(""); const [reviewNote, setReviewNote] = useState("");
  const column = boardColumnForTask(task, allTasks); const attempts = attemptsForTask(detail, task.id); const comments = commentsForTask(detail, task); const artifacts = artifactsForTask(detail, task.id).filter((artifact) => !isCommentArtifact(artifact));
  const assignmentOptions = agents.filter(
    (agent) => agent.selectable || agent.id === assigneeId,
  );
  function save(event: React.FormEvent) {
    event.preventDefault();
    if (disabledReason) return;
    const unchangedReadOnlyAssignee = Boolean(
      assigneeId &&
      assigneeId === originalAssigneeId &&
      agents.find((agent) => agent.id === assigneeId)?.selectable !== true,
    );
    onSave({
      title: title.trim(),
      instructions: instructions.trim(),
      definitionOfDone: definitionOfDone.trim(),
      priority,
      ...(unchangedReadOnlyAssignee ? {} : { assigneeId: assigneeId || null }),
      reviewRequired,
      blocker: blockerReason.trim()
        ? { kind: "needs_input", reason: blockerReason.trim() }
        : null,
      dependencyIds,
    });
  }
  function toggleDependency(id: string) { setDependencyIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]); }
  return <div className={styles.drawerBackdrop} onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className={styles.drawer} role="dialog" aria-modal="true" aria-labelledby="task-drawer-title">
    <header className={styles.drawerHeader}><div><p>Task details</p><h2 id="task-drawer-title">{task.title}</h2></div><button ref={closeRef} type="button" onClick={onClose} aria-label="Close task details"><X size={17} /></button></header>
    <div className={styles.drawerStatus}><span><i className={columnToneClass(column)} aria-hidden="true" />{boardColumnLabel(column)}</span><span>{taskAssigneeLabel(task, agentNames)}</span><span>Updated {relativeTime(task.updatedAt, asOf)}</span></div>
    {disabledReason ? <div className={styles.drawerError} role="status"><ShieldCheck size={14} aria-hidden="true" /><span>{disabledReason}</span></div> : null}
    {error ? <div className={styles.drawerError} role="alert"><CircleAlert size={14} aria-hidden="true" /><span>{error}</span></div> : null}
    <form className={styles.taskForm} onSubmit={save}>
      <label>Title<input value={title} onChange={(event) => setTitle(event.currentTarget.value)} maxLength={240} disabled={Boolean(disabledReason)} /></label>
      <label>Working instructions<textarea value={instructions} onChange={(event) => setInstructions(event.currentTarget.value)} rows={5} maxLength={8000} disabled={Boolean(disabledReason)} /></label>
      <label>Definition of done<textarea value={definitionOfDone} onChange={(event) => setDefinitionOfDone(event.currentTarget.value)} rows={4} maxLength={2000} disabled={Boolean(disabledReason)} /></label>
      <div className={styles.formGrid}><label>Priority<select value={priority} onChange={(event) => setPriority(event.currentTarget.value as BoardTask["priority"])} disabled={Boolean(disabledReason)}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label><label>Assignee<select value={assigneeId} onChange={(event) => setAssigneeId(event.currentTarget.value)} disabled={Boolean(disabledReason)}><option value="">Unassigned</option>{assignmentOptions.map((agent) => <option key={agent.id} value={agent.id} disabled={!agent.selectable}>{agent.name}{agent.selectable ? "" : " · read only"}</option>)}</select></label></div>
      <label className={styles.checkLabel}><input type="checkbox" checked={reviewRequired} onChange={(event) => setReviewRequired(event.currentTarget.checked)} disabled={Boolean(disabledReason)} /><span><strong>Review required</strong><small>Require evidence acceptance before completion.</small></span></label>
      <label>Blocker or requested input<textarea value={blockerReason} onChange={(event) => setBlockerReason(event.currentTarget.value)} rows={2} maxLength={2000} placeholder="Describe exactly what is needed to continue." disabled={Boolean(disabledReason)} /></label>
      <details className={styles.drawerDisclosure} open><summary><span><GitBranch size={14} aria-hidden="true" /> Dependencies</span><b>{dependencyIds.length}</b></summary><div className={styles.dependencyEditor}>{allTasks.filter((candidate) => candidate.id !== task.id).length ? allTasks.filter((candidate) => candidate.id !== task.id).map((candidate) => <label key={candidate.id}><input type="checkbox" checked={dependencyIds.includes(candidate.id)} onChange={() => toggleDependency(candidate.id)} disabled={Boolean(disabledReason)} /><span><strong>{candidate.title}</strong><small>{boardColumnLabel(boardColumnForTask(candidate, allTasks))}</small></span></label>) : <p>No other tasks can be linked yet.</p>}</div></details>
      <button className={styles.saveTask} type="submit" disabled={busy || Boolean(disabledReason) || !title.trim()}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save changes</button>
    </form>
    <section className={styles.taskActions} aria-labelledby="task-actions-title"><header><div><p>State controls</p><h3 id="task-actions-title">Move work forward</h3></div>{busy ? <Loader2 size={15} className="animate-spin" aria-label="Saving" /> : null}</header>{column === "review" ? <label className={styles.reviewNote}>Review note<textarea value={reviewNote} onChange={(event) => setReviewNote(event.currentTarget.value)} rows={2} maxLength={4000} placeholder="Add acceptance notes or explain the requested changes." disabled={Boolean(disabledReason)} /></label> : null}<div>{taskActionsFor(column, task).map((action) => action.kind === "review" ? <button key={action.action} type="button" disabled={busy || Boolean(disabledReason) || (action.action === "request_changes" && !reviewNote.trim())} className={action.tone === "primary" ? styles.actionPrimary : action.tone === "danger" ? styles.actionDanger : undefined} onClick={() => onReview(action.action as ReviewAction, reviewNote)}>{actionIcon(action.action)} {action.label}</button> : <button key={action.action} type="button" disabled={busy || Boolean(disabledReason)} className={action.tone === "primary" ? styles.actionPrimary : action.tone === "danger" ? styles.actionDanger : undefined} onClick={() => onAction(action.action as TaskAction)}>{actionIcon(action.action)} {action.label}</button>)}</div></section>
    <section className={styles.drawerSection} aria-labelledby="comments-title"><header><div><p>Collaboration</p><h3 id="comments-title">Comments</h3></div><span>{comments.length}</span></header><div className={styles.commentList}>{comments.length ? comments.map((item) => <article key={item.id}><span>{initials(item.authorName || "You")}</span><div><strong>{item.authorName || "You"}<small>{relativeTime(item.createdAt, asOf)}</small></strong><p>{item.body}</p></div></article>) : <p>No comments yet. Add context without interrupting the task history.</p>}</div><form className={styles.commentForm} onSubmit={(event) => { event.preventDefault(); if (!comment.trim() || disabledReason) return; void onComment(comment).then((saved) => { if (saved) setComment(""); }); }}><label className="sr-only" htmlFor={`comment-${task.id}`}>Add a comment</label><textarea id={`comment-${task.id}`} value={comment} onChange={(event) => setComment(event.currentTarget.value)} rows={2} placeholder="Add context or an instruction…" disabled={Boolean(disabledReason)} /><button type="submit" disabled={busy || Boolean(disabledReason) || !comment.trim()}><Send size={13} aria-hidden="true" /> Comment</button></form></section>
    <section className={styles.drawerSection} aria-labelledby="attempts-title"><header><div><p>Execution</p><h3 id="attempts-title">Attempt history</h3></div><span>{attempts.length}</span></header><div className={styles.timeline}>{attempts.length ? attempts.map((attempt) => <article key={attempt.id}><i className={statusToneClass(attempt.status)} aria-hidden="true" /><div><strong>{attempt.executorType.replaceAll("_", " ")}</strong><p>{attemptStatusCopy(attempt.status)}</p><small>{relativeTime(attempt.updatedAt, asOf)}</small></div></article>) : <p>No agent attempt has been attached to this task.</p>}</div></section>
    <section className={styles.drawerSection} aria-labelledby="evidence-title"><header><div><p>Proof</p><h3 id="evidence-title">Evidence & handoffs</h3></div><span>{artifacts.length}</span></header><div className={styles.evidenceList}>{artifacts.length ? artifacts.map((artifact) => <article key={artifact.id}><span>{isHandoffArtifact(artifact) ? <CheckCircle2 size={15} /> : <FileText size={15} />}</span><div><strong>{artifact.title}</strong><p>{artifactPreview(artifact) || `${artifact.kind.replaceAll("_", " ")} recorded for this task.`}</p><small>{relativeTime(artifact.createdAt, asOf)}</small></div></article>) : <p>Receipts, files, and structured handoffs will appear here.</p>}</div></section>
  </aside></div>;
}

type TaskAction = "promote" | "start" | "block" | "unblock" | "complete" | "cancel";

function taskActionsFor(column: BoardColumnId, task: BoardTask) {
  if (column === "inbox") return [{ kind: "task", action: "promote", label: "Move to Ready", tone: "primary" }, { kind: "task", action: "cancel", label: "Cancel", tone: "danger" }];
  if (column === "waiting") return [{ kind: "task", action: "block", label: "Mark blocked", tone: "default" }, { kind: "task", action: "cancel", label: "Cancel", tone: "danger" }];
  if (column === "ready") return [{ kind: "task", action: "start", label: "Mark in progress", tone: "primary" }, { kind: "task", action: "block", label: "Block", tone: "default" }, { kind: "task", action: "cancel", label: "Cancel", tone: "danger" }];
  if (column === "working") return [...(taskReviewRequired(task) ? [{ kind: "review", action: "request_review", label: "Request review", tone: "primary" }] : [{ kind: "task", action: "complete", label: "Complete", tone: "primary" }]), { kind: "task", action: "block", label: "Block", tone: "default" }, { kind: "task", action: "cancel", label: "Cancel", tone: "danger" }];
  if (column === "needs-you") return [{ kind: "task", action: "unblock", label: "Unblock", tone: "primary" }, { kind: "task", action: "cancel", label: "Cancel", tone: "danger" }];
  if (column === "review") return [{ kind: "review", action: "approve", label: "Approve", tone: "primary" }, { kind: "review", action: "request_changes", label: "Request changes", tone: "default" }, { kind: "task", action: "cancel", label: "Cancel", tone: "danger" }];
  return [];
}

function taskActionPatch(action: TaskAction, task: BoardTask): Record<string, unknown> {
  if (action === "promote" || action === "unblock") return { status: "pending", blocker: null };
  if (action === "start") return { status: "running" };
  if (action === "complete") return { status: "succeeded" };
  if (action === "cancel") return { status: "canceled" };
  return {
    status: "blocked",
    blocker: {
      kind: "needs_input",
      reason: taskBlockerReason(task) || "Human input is required before this task can continue.",
    },
  };
}

function actionIcon(action: string) {
  if (["promote", "start", "unblock"].includes(action)) return <Play size={13} aria-hidden="true" />;
  if (["complete", "approve"].includes(action)) return <Check size={13} aria-hidden="true" />;
  if (action === "request_review") return <ShieldCheck size={13} aria-hidden="true" />;
  if (action === "request_changes") return <RefreshCw size={13} aria-hidden="true" />;
  if (action === "block") return <CircleAlert size={13} aria-hidden="true" />;
  return <X size={13} aria-hidden="true" />;
}

function useDialogFocus(onClose: () => void) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => closeRef.current?.focus(), 0);
    const handleKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => { window.clearTimeout(timer); window.removeEventListener("keydown", handleKey); previous?.focus(); };
  }, [onClose]);
  return closeRef;
}

function MissionListSkeleton() { return <div className={styles.listSkeleton} aria-hidden="true">{[0, 1, 2, 3].map((item) => <i key={item} />)}</div>; }
function CanvasSkeleton() { return <div className={styles.canvasSkeleton} aria-hidden="true"><i /><i /><i /><i /></div>; }

function missionIdFromPath(pathname: string) { const match = pathname.match(/^\/app\/missions\/([^/]+)\/?$/); if (!match) return ""; try { return decodeURIComponent(match[1]); } catch { return ""; } }
function pushMissionHistory(id: string) { const nextPath = `/app/missions/${encodeURIComponent(id)}`; if (window.location.pathname !== nextPath) window.history.pushState(null, "", nextPath); }
function replaceMissionHistory(path: string) { if (window.location.pathname !== path) window.history.replaceState(null, "", path); }
function missionStatusLabel(status: MissionStatus) { return ({ draft: "Draft", queued: "Queued", running: "Running", waiting: "Needs attention", succeeded: "Completed", failed: "Failed", canceled: "Canceled", archived: "Archived" })[status]; }
function statusToneClass(status: string) { if (["running", "succeeded", "completed", "approved"].includes(status)) return styles.toneGood; if (["waiting", "blocked", "queued", "review"].includes(status)) return styles.toneAttention; if (["failed", "canceled"].includes(status)) return styles.toneDanger; return styles.toneNeutral; }
function columnToneClass(column: BoardColumnId) { if (["working", "done"].includes(column)) return styles.toneGood; if (["waiting", "needs-you", "review"].includes(column)) return styles.toneAttention; if (column === "ready") return styles.toneReady; return styles.toneNeutral; }
function priorityClass(priority: string) { if (priority === "urgent") return styles.priorityUrgent; if (priority === "high") return styles.priorityHigh; if (priority === "low") return styles.priorityLow; return styles.priorityNormal; }
function cueClass(column: BoardColumnId) { if (["needs-you", "review", "waiting"].includes(column)) return styles.cueAttention; if (column === "done") return styles.cueDone; return styles.cueNeutral; }
function boardColumnLabel(column: BoardColumnId) { return BOARD_COLUMNS.find((item) => item.id === column)?.title || "Inbox"; }

function boardColumnForTask(task: BoardTask, allTasks: BoardTask[]): BoardColumnId {
  const meta = taskMeta(task);
  const explicit = stringValue(meta.boardStage, meta.column, meta.stage)?.toLowerCase().replaceAll("_", "-");
  if (explicit && BOARD_COLUMNS.some((column) => column.id === explicit)) return explicit as BoardColumnId;
  if (["review", "in-review", "review-requested"].includes(explicit || "")) return "review";
  const reviewStatus = stringValue(meta.reviewStatus, meta.reviewState)?.toLowerCase();
  if (["requested", "pending", "in_review", "in-review"].includes(reviewStatus || "")) return "review";
  if (["succeeded", "failed", "canceled", "completed"].includes(task.status)) return "done";
  if (task.status === "review") return "review";
  if (task.status === "blocked") return "needs-you";
  if (task.status === "running") return "working";
  if (task.status === "triage" || explicit === "inbox" || boolValue(meta.triage, meta.needsTriage)) return "inbox";
  const progress = dependencyProgress(task, allTasks);
  if (isFutureTask(task) || progress.done < progress.total) return "waiting";
  return "ready";
}

function taskCue(task: BoardTask, column: BoardColumnId) { const changesRequested = stringValue(taskMeta(task).changesRequestedReason); if (column === "needs-you") return taskBlockerReason(task) || "Input required"; if (column === "review") return "Review requested"; if (changesRequested && !["review", "done"].includes(column)) return "Changes requested"; if (column === "waiting" && isFutureTask(task)) return "Scheduled"; if (column === "waiting") return "Waiting on dependencies"; if (column === "done" && task.status !== "succeeded") return task.status === "failed" ? "Failed" : "Canceled"; return ""; }
function taskMeta(task: BoardTask) { const direct = record(task.metadata); const input = record((task as unknown as Record<string, unknown>).input); const board = record(direct.board); return { ...input, ...direct, ...board }; }
function taskAssigneeId(task: BoardTask) { const meta = taskMeta(task); const direct = task as unknown as Record<string, unknown>; const assignee = record(meta.assignee); return stringValue(task.assigneeId, direct.assigneeId, meta.assigneeId, meta.assigneeKey, meta.agentId, assignee.id) || "unassigned"; }
function taskAssigneeLabel(task: BoardTask, agents: Map<string, string>) { const meta = taskMeta(task); const assignee = record(meta.assignee); const id = taskAssigneeId(task); return task.assigneeName || stringValue(meta.assigneeName, meta.agentName, assignee.name) || agents.get(id) || "Unassigned"; }
function taskReviewRequired(task: BoardTask) { const meta = taskMeta(task); return boolValue(task.reviewRequired, meta.reviewRequired, meta.requiresReview) ?? false; }
function taskBlockerReason(task: BoardTask) { const meta = taskMeta(task); const blocker = record(meta.blocker); return task.blockerReason || stringValue(meta.blockerReason, meta.blockReason, meta.requestedInput, blocker.reason) || ""; }
function taskRetryCount(task: BoardTask, attemptCount: number) { const meta = taskMeta(task); return numberValue(task.retryCount, meta.retryCount, meta.retries) ?? Math.max(0, attemptCount - 1); }
function taskScheduledFor(task: BoardTask) { const meta = taskMeta(task); return task.scheduledFor || stringValue(meta.scheduledFor, meta.scheduledAt, meta.runAt, meta.scheduleAt); }
function isFutureTask(task: BoardTask) { const scheduledFor = taskScheduledFor(task); if (!scheduledFor) return false; const timestamp = Date.parse(scheduledFor); return Number.isFinite(timestamp) && timestamp > Date.now(); }
function dependencyProgress(task: BoardTask, tasks: BoardTask[]) { const dependencies = task.dependencyIds || []; const done = dependencies.filter((id) => tasks.find((candidate) => candidate.id === id)?.status === "succeeded").length; return { done, total: dependencies.length }; }
function attemptsForTask(detail: BoardMissionDetail | undefined, taskId: string) { return (detail?.attempts || []).filter((attempt) => attempt.taskId === taskId).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)); }
function artifactsForTask(detail: BoardMissionDetail | undefined, taskId: string) { return (detail?.artifacts || []).filter((artifact) => artifact.taskId === taskId).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)); }

function commentsForTask(detail: BoardMissionDetail | undefined, task: BoardTask): BoardComment[] {
  const taskComments = Array.isArray(task.comments) ? task.comments : [];
  const rootComments = Array.isArray(detail?.comments) ? detail.comments.filter((comment) => comment.taskId === task.id) : [];
  const artifactComments = artifactsForTask(detail, task.id).filter(isCommentArtifact).map((artifact) => ({ id: artifact.id, body: artifactPreview(artifact) || artifact.title, authorName: stringValue(record(artifact.metadata).authorName, record(artifact.data).authorName), createdAt: artifact.createdAt }));
  return [...taskComments, ...rootComments, ...artifactComments].filter((comment, index, items) => items.findIndex((item) => item.id === comment.id) === index).sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

function isCommentArtifact(artifact: BoardArtifact) { return artifact.kind.toLowerCase().includes("comment"); }
function isHandoffArtifact(artifact: BoardArtifact) { return artifact.kind.toLowerCase().includes("handoff"); }
function artifactPreview(artifact: BoardArtifact) { const metadata = record(artifact.metadata); const data = record(artifact.data); return artifact.preview || stringValue(metadata.preview, metadata.summary, metadata.body, data.preview, data.summary, data.body); }

export function normalizeMissionSummaries(value: unknown) {
  if (!Array.isArray(value) || value.length > 50) return undefined;
  const summaries = value.map(normalizeMissionSummary);
  if (summaries.some((mission) => !mission)) return undefined;
  const normalized = summaries as MissionSummaryView[];
  if (new Set(normalized.map((mission) => mission.id)).size !== normalized.length) {
    return undefined;
  }
  return normalized;
}

export function normalizeMissionSummary(value: unknown): MissionSummaryView | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const mission = value as Record<string, unknown>;
  const canonicalStatus = record(mission.canonicalStatus);
  if (
    !isMissionIdentifier(mission.id) ||
    !isBoundedMissionLine(mission.title, 240) ||
    !isBoundedMissionTextBlock(mission.objective, 4_000) ||
    !isMissionStatus(mission.status) ||
    !isMissionPriority(mission.priority) ||
    !isBoundedMissionLine(mission.source, 80) ||
    (mission.startedAt !== undefined && !isIsoTimestamp(mission.startedAt)) ||
    (mission.terminalAt !== undefined && !isIsoTimestamp(mission.terminalAt)) ||
    !isIsoTimestamp(mission.createdAt) ||
    !isIsoTimestamp(mission.updatedAt) ||
    typeof mission.detailAvailable !== "boolean" ||
    typeof mission.manageable !== "boolean" ||
    typeof mission.runnable !== "boolean" ||
    (mission.detailAvailable !== true &&
      (mission.manageable === true || mission.runnable === true))
  ) return undefined;
  const status = mission.status as MissionStatus;
  const startedAt = mission.startedAt as string | undefined;
  const terminalAt = mission.terminalAt as string | undefined;
  const createdAt = mission.createdAt as string;
  const updatedAt = mission.updatedAt as string;
  const terminalStatus = ["succeeded", "failed", "canceled", "archived"].includes(status);
  if (
    createdAt > updatedAt ||
    (startedAt !== undefined && (startedAt < createdAt || startedAt > updatedAt)) ||
    (terminalAt !== undefined && (terminalAt < createdAt || terminalAt > updatedAt)) ||
    (startedAt !== undefined && terminalAt !== undefined && startedAt > terminalAt) ||
    (status === "running" && startedAt === undefined) ||
    ((status === "draft" || status === "queued") && startedAt !== undefined) ||
    (terminalStatus ? terminalAt === undefined : terminalAt !== undefined)
  ) return undefined;
  const expectedCanonicalStatus = canonicalStatusForMission(status);
  if (
    canonicalStatus.schemaVersion !== expectedCanonicalStatus.schemaVersion ||
    canonicalStatus.status !== expectedCanonicalStatus.status ||
    canonicalStatus.domain !== expectedCanonicalStatus.domain ||
    canonicalStatus.basis !== expectedCanonicalStatus.basis ||
    canonicalStatus.source !== expectedCanonicalStatus.source ||
    canonicalStatus.sourceStatus !== expectedCanonicalStatus.sourceStatus ||
    canonicalStatus.verificationState !== expectedCanonicalStatus.verificationState
  ) return undefined;
  return {
    id: mission.id as string,
    title: mission.title as string,
    objective: mission.objective as string,
    status,
    canonicalStatus: {
      schemaVersion: expectedCanonicalStatus.schemaVersion,
      status: expectedCanonicalStatus.status,
      domain: expectedCanonicalStatus.domain,
      basis: expectedCanonicalStatus.basis,
      source: expectedCanonicalStatus.source,
      sourceStatus: expectedCanonicalStatus.sourceStatus,
      verificationState: expectedCanonicalStatus.verificationState,
    },
    priority: mission.priority as MissionSummaryView["priority"],
    source: mission.source as string,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(terminalAt !== undefined ? { terminalAt } : {}),
    createdAt,
    updatedAt,
    detailAvailable: mission.detailAvailable as boolean,
    manageable: mission.manageable as boolean,
    runnable: mission.runnable as boolean,
  };
}

export function normalizeMissionDetail(
  value: unknown,
  expectedId: string,
): MissionDetailView | undefined {
  if (!missionDetailHasExpectedId(value, expectedId)) return undefined;
  const detail = value as Record<string, unknown>;
  const mission = normalizeMissionSummary(detail.mission);
  if (!mission) return undefined;
  return {
    mission,
    tasks: detail.tasks as MissionDetailView["tasks"],
    attempts: detail.attempts as MissionDetailView["attempts"],
    artifacts: detail.artifacts as MissionDetailView["artifacts"],
  };
}

export function missionDetailHasExpectedId(
  value: unknown,
  expectedId: string,
): value is BoardMissionDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const detail = value as Record<string, unknown>;
  const mission = normalizeMissionSummary(detail.mission);
  if (
    mission?.id !== expectedId ||
    !Array.isArray(detail.tasks) ||
    !Array.isArray(detail.attempts) ||
    !Array.isArray(detail.artifacts) ||
    detail.tasks.length > 100 ||
    detail.attempts.length > 250 ||
    detail.artifacts.length > 150
  ) return false;
  const scopedItemsAreValid = (items: unknown[]) => {
    const ids = new Set<string>();
    return items.every((item) => {
      const candidate = record(item);
      if (!isMissionIdentifier(candidate.id) || candidate.missionId !== expectedId) {
        return false;
      }
      if (ids.has(candidate.id)) return false;
      ids.add(candidate.id);
      return true;
    });
  };
  return scopedItemsAreValid(detail.tasks) &&
    scopedItemsAreValid(detail.attempts) &&
    scopedItemsAreValid(detail.artifacts);
}

function isMissionStatus(value: unknown): value is MissionStatus {
  return typeof value === "string" &&
    ["draft", "queued", "running", "waiting", "succeeded", "failed", "canceled", "archived"].includes(value);
}

function isMissionPriority(value: unknown): value is MissionSummaryView["priority"] {
  return typeof value === "string" && ["low", "normal", "high", "urgent"].includes(value);
}

function isMissionIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,240}$/.test(value);
}

function isBoundedMissionLine(value: unknown, maximum: number): value is string {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximum &&
    value.replace(/\s+/g, " ").trim() === value;
}

function isBoundedMissionTextBlock(value: unknown, maximum: number): value is string {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximum &&
    value.trim() === value;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  try {
    return parsed.toISOString() === value;
  } catch {
    return false;
  }
}

function agentOptions(payload: Record<string, unknown>): AgentOption[] {
  const combined = [
    ...(Array.isArray(payload.builtIns) ? payload.builtIns : []).map((value) => ({ value, builtIn: true })),
    ...(Array.isArray(payload.agents) ? payload.agents : []).map((value) => ({ value, builtIn: false })),
  ];
  return combined.flatMap(({ value, builtIn }) => {
    const item = record(value);
    const id = stringValue(item.id, item.slug);
    const name = stringValue(item.name);
    return id && name
      ? [{
          id,
          name,
          role: stringValue(item.role),
          selectable: builtIn || item.selectable === true,
        }]
      : [];
  }).filter((agent, index, items) =>
    items.findIndex((item) => item.id === agent.id) === index
  );
}

function buildTaskGraph(tasks: BoardTask[], allTasks: BoardTask[]) {
  const visibleIds = new Set(tasks.map((task) => task.id)); const byId = new Map(allTasks.map((task) => [task.id, task])); const depthMemo = new Map<string, number>();
  const depthFor = (task: BoardTask, visiting = new Set<string>()): number => {
    const cached = depthMemo.get(task.id); if (cached !== undefined) return cached; if (visiting.has(task.id)) return 0;
    const nextVisiting = new Set(visiting).add(task.id);
    const parents = [...(task.parentTaskId ? [task.parentTaskId] : []), ...(task.dependencyIds || [])].map((id) => byId.get(id)).filter((item): item is BoardTask => Boolean(item));
    const depth = parents.length ? Math.min(5, 1 + Math.max(...parents.map((parent) => depthFor(parent, nextVisiting)))) : 0; depthMemo.set(task.id, depth); return depth;
  };
  const levels = new Map<number, BoardTask[]>(); tasks.forEach((task) => { const depth = depthFor(task); levels.set(depth, [...(levels.get(depth) || []), task]); });
  const maxDepth = Math.max(...levels.keys(), 0); const maxRows = Math.max(...[...levels.values()].map((items) => items.length), 1); const width = Math.max(760, 80 + (maxDepth + 1) * 292); const height = Math.max(420, 90 + maxRows * 126);
  const nodes = [...levels.entries()].flatMap(([depth, levelTasks]) => levelTasks.map((task, row) => ({ task, x: 42 + depth * 292, y: 68 + row * 126 }))); const nodeById = new Map(nodes.map((node) => [node.task.id, node])); const edgeKeys = new Set<string>();
  const edges = tasks.flatMap((task) => { const target = nodeById.get(task.id); if (!target) return []; const sources = [...(task.parentTaskId ? [task.parentTaskId] : []), ...(task.dependencyIds || [])]; return sources.flatMap((sourceId) => { if (!visibleIds.has(sourceId)) return []; const source = nodeById.get(sourceId); const key = `${sourceId}-${task.id}`; if (!source || edgeKeys.has(key)) return []; edgeKeys.add(key); const x1 = source.x + 218; const y1 = source.y + 40; const x2 = target.x - 9; const y2 = target.y + 40; const bend = Math.max(24, (x2 - x1) / 2); return [{ from: sourceId, to: task.id, path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}` }]; }); });
  return { width, height, nodes, edges };
}

function initials(value: string) { const parts = value.trim().split(/\s+/).filter(Boolean); return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : parts[0]?.slice(0, 2) || "—").toUpperCase(); }
function talkHref(mission: MissionSummaryView) { const prompt = "Continue this mission. Review its durable task board, advance only ready work within governed authority, preserve evidence, and surface blockers."; return `/app/command?mission=${encodeURIComponent(mission.id)}&prompt=${encodeURIComponent(prompt)}`; }
function relativeTime(value: string, asOf: number) { if (!asOf) return "recently"; const delta = asOf - Date.parse(value); if (!Number.isFinite(delta) || delta < 0) return "just now"; const minutes = Math.floor(delta / 60_000); if (minutes < 1) return "just now"; if (minutes < 60) return `${minutes}m ago`; const hours = Math.floor(minutes / 60); return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`; }
function attemptStatusCopy(status: string) { if (status === "running") return "Agent is actively working."; if (["waiting", "waiting_approval"].includes(status)) return "Paused for an external decision."; if (status === "succeeded") return "Attempt completed and returned evidence."; if (status === "failed") return "Attempt stopped before completion."; if (status === "canceled") return "Attempt was canceled."; return "Waiting for an available worker."; }
function taskActionLabel(action: TaskAction) { return ({ promote: "Task moved to Ready.", start: "Task started.", block: "Task marked as blocked.", unblock: "Task returned to Ready.", complete: "Task completed.", cancel: "Task canceled." })[action]; }
function reviewActionLabel(action: ReviewAction) { return ({ request_review: "Task sent for review.", approve: "Task review approved.", request_changes: "Task returned for changes." })[action]; }
function taskIdFromMutation(payload: Record<string, unknown>) { const task = record(payload.task); return stringValue(task.id, payload.id); }
function missionEventCursor(value: unknown, fallback: number) { return typeof value === "number" && Number.isSafeInteger(value) && value >= fallback ? value : fallback; }
function missionEventProjection(value: unknown) { if (!value || typeof value !== "object") return undefined; const candidate = value as { status?: unknown; updatedAt?: unknown }; const statuses: MissionStatus[] = ["draft", "queued", "running", "waiting", "succeeded", "failed", "canceled", "archived"]; if (typeof candidate.status !== "string" || !statuses.includes(candidate.status as MissionStatus) || typeof candidate.updatedAt !== "string") return undefined; return { status: candidate.status as MissionStatus, updatedAt: candidate.updatedAt }; }
function missionEventPollDelay(consecutiveFailures: number) { const failureCount = Math.min(Math.max(consecutiveFailures, 0), 4); return Math.min(2_500 * (2 ** failureCount), 30_000); }

class ApiRequestError extends Error { constructor(readonly status: number) { super("Request failed"); } }
class MissionDetailContractError extends Error {}
async function readJson(path: string, init?: RequestInit) { const response = await fetch(path, { cache: "no-store", ...init }); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new ApiRequestError(response.status); return payload as Record<string, unknown>; }
function friendlyMessage(error: unknown, operation: "load" | "create" | "update") { if (error instanceof ApiRequestError) { if (error.status === 401) return "Your session has ended. Sign in and try again."; if (error.status === 403) return "You do not have permission to make this change."; if (error.status === 404) return "This mission or task is no longer available."; if (error.status === 409) return "The task changed elsewhere. Refresh it before trying again."; if (error.status === 429) return "The workspace is busy. Wait a moment and try again."; if (error.status >= 500) return "The mission service is temporarily unavailable. Your existing board is still safe."; } if (operation === "load") return "Missions could not be loaded. Check your connection and try again."; if (operation === "create") return "That item could not be created. Review the details and try again."; return "That change could not be saved. Refresh the task and try again."; }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function stringValue(...values: unknown[]) { return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim(); }
function boolValue(...values: unknown[]) { return values.find((value): value is boolean => typeof value === "boolean"); }
function numberValue(...values: unknown[]) { return values.find((value): value is number => typeof value === "number" && Number.isFinite(value)); }
