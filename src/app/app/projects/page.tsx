import type { Metadata } from "next";
import { ProjectsWorkspace } from "@/components/projects-workspace";

export const metadata: Metadata = { title: "Projects" };
export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  return <ProjectsWorkspace initialView={query.view === "execution" ? "execution" : "overview"} />;
}
