import type { Metadata } from "next";
import { ProjectsWorkspace } from "@/components/projects-workspace";

export const metadata: Metadata = { title: "Projects" };
export default function ProjectsPage() { return <ProjectsWorkspace />; }
