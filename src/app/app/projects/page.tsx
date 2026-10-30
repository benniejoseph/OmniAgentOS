import type { Metadata } from "next";
import { ProjectsWorkspace } from "@/components/projects-workspace";
import { CsmWorkspace } from "@/components/csm-workspace";

export const metadata: Metadata = { title: "Work" };
export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const deployment = process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "local";
  // Keep existing client deep links intact while making general work the entry.
  const showProjects = query.view === "projects" || query.view === "execution" || query.view === "build" || query.fromSearch === "1" || (query.view !== "clients" && query.view !== "role" && !query.project);
  if (!showProjects) {
    const initialProjectId = typeof query.project === "string" && /^[a-zA-Z0-9_.:-]{1,200}$/.test(query.project) ? query.project : undefined;
    return <CsmWorkspace deployment={deployment} initialProjectId={initialProjectId} initialView={query.view === "role" ? "role" : "clients"} />;
  }
  const initialView = query.view === "execution" ? "execution" : query.view === "build" ? "build" : "overview";
  return <ProjectsWorkspace initialView={initialView} deployment={deployment} />;
}
