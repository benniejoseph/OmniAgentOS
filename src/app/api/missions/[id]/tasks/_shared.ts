import { randomUUID } from "node:crypto";
import {
  MissionConflictError,
  MissionNotFoundError,
  MissionTransitionError,
} from "@/lib/missions/store";

export class MissionTaskInputError extends Error {}

export const PRIVATE_NO_STORE_HEADERS = {
  "cache-control": "private, no-store",
};

export function missionTaskMutationError(error: unknown) {
  if (error instanceof MissionNotFoundError) {
    return Response.json({ error: "Mission task not found." }, {
      status: 404,
      headers: PRIVATE_NO_STORE_HEADERS,
    });
  }
  if (error instanceof MissionConflictError || error instanceof MissionTransitionError) {
    return Response.json({ error: error.message }, {
      status: 409,
      headers: PRIVATE_NO_STORE_HEADERS,
    });
  }
  if (error instanceof MissionTaskInputError) {
    return Response.json({ error: error.message }, {
      status: 400,
      headers: PRIVATE_NO_STORE_HEADERS,
    });
  }
  console.error("Mission task mutation failed.", error instanceof Error ? error.name : "UnknownError");
  return Response.json({ error: "Mission task mutation failed." }, {
    status: 500,
    headers: PRIVATE_NO_STORE_HEADERS,
  });
}

export function missionTaskSourceKey(
  request: Request,
  bodySourceKey: string | undefined,
  namespace: "task" | "comment" | "review",
  scopeId: string,
) {
  if (bodySourceKey) {
    return `kanban:${namespace}:${scopeId}:provided:${bodySourceKey}`;
  }
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (idempotencyKey) {
    if (!/^[a-zA-Z0-9._:-]{1,200}$/.test(idempotencyKey)) {
      throw new MissionTaskInputError("Idempotency-Key is invalid.");
    }
    return `kanban:${namespace}:${scopeId}:${idempotencyKey}`;
  }
  return `kanban:${namespace}:${scopeId}:${randomUUID()}`;
}

export function sameTimestamp(left: string, right: string) {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime;
}
