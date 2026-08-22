import {
  getIncident,
  getIncidentPlaybooks,
  recordIncidentEvent,
} from "@/lib/diagnostics/incidents";
import { runSystemDiagnostics } from "@/lib/diagnostics/health";

export async function runIncidentPlaybook({
  tenantId,
  incidentId,
  playbookId,
  actorId,
}: {
  tenantId: string;
  incidentId: string;
  playbookId: string;
  actorId: string;
}) {
  const incident = await getIncident(incidentId, { tenantId });
  if (!incident) {
    return null;
  }

  const playbook = getIncidentPlaybooks().find((item) => item.id === playbookId);
  if (!playbook || !incident.playbookIds.includes(playbook.id)) {
    throw new Error("Incident playbook is not available for this incident.");
  }

  if (playbook.automation === "manual") {
    const event = await recordIncidentEvent({
      tenantId,
      incidentId,
      type: "playbook_run",
      actorId,
      message: `Prepared manual playbook: ${playbook.name}.`,
      metadata: {
        playbookId: playbook.id,
        automation: playbook.automation,
        status: "planned",
      },
    });
    return { incident, playbook, event, check: null, status: "planned" as const };
  }

  const check = playbook.automation === "diagnostics_repair"
    ? await runSystemDiagnostics({ scope: "repair", repair: true, tenantId })
    : await runSystemDiagnostics({ scope: "diagnostics", tenantId });
  const completedRecoveries = check.recoveryActions.filter((action) => action.status === "completed").length;
  const event = await recordIncidentEvent({
    tenantId,
    incidentId,
    type: "playbook_run",
    actorId,
    message: `Ran playbook ${playbook.name}; health is ${check.status}.`,
    metadata: {
      playbookId: playbook.id,
      automation: playbook.automation,
      checkId: check.id,
      healthStatus: check.status,
      completedRecoveries,
    },
  });

  return {
    incident,
    playbook,
    event,
    check,
    status: completedRecoveries > 0 ? "completed" as const : "checked" as const,
  };
}
