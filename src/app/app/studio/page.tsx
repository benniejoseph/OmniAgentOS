import type { Metadata } from "next";
import { StudioEntry } from "@/components/studio/entry";
import { STUDIO_TEMPLATES } from "@/lib/studio/templates";

export const metadata: Metadata = { title: "Visual Studio" };
export default async function StudioPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const safe = (value: unknown) =>
    typeof value === "string" && /^[a-zA-Z0-9:_-]{1,160}$/.test(value)
      ? value
      : undefined;
  return (
    <StudioEntry
      initialFlowId={safe(params.flow)}
      initialProjectId={safe(params.project)}
      deployment={
        process.env.VERCEL_DEPLOYMENT_ID ??
        process.env.VERCEL_GIT_COMMIT_SHA ??
        "local"
      }
      templates={STUDIO_TEMPLATES.map(({ id, name, description }) => ({
        id,
        name,
        description,
      }))}
    />
  );
}
