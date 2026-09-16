import { describe, expect, it, vi } from "vitest";

import {
  ensureAppBuilderDeploymentUrlConstraintRepairV1,
  ensureAppBuilderRepositoryGitPreviewV1,
  ensureAppBuilderRepositoryWorkspacesV1,
  type AppBuilderRepositorySchemaSqlClient,
} from "@/lib/db/app-builder-repository-schema";

describe("App Builder repository schema module", () => {
  it("keeps the deployment URL repair bounded to the literal Vercel host", async () => {
    const sql = sqlRecorder();

    await ensureAppBuilderDeploymentUrlConstraintRepairV1(sql.client);

    expect(sql.queries.join("\n")).toContain("[.]vercel[.]app");
    expect(sql.queries.join("\n")).toContain(
      "App Builder deployment URL constraint repair is invalid",
    );
  });

  it("preserves repository workspace capacity and exact event kinds", async () => {
    const sql = sqlRecorder();

    await ensureAppBuilderRepositoryWorkspacesV1(sql.client);

    const query = sql.queries.join("\n");
    expect(query).toContain("file_count BETWEEN 1 AND 10000");
    expect(query).toContain("app_builder.repository.checked_out");
    expect(query).toContain("app_builder.release.production_healthy");
  });

  it("preserves exact Git preview constraints and postflight", async () => {
    const sql = sqlRecorder();

    await ensureAppBuilderRepositoryGitPreviewV1(sql.client);

    expect(sql.queries.join("\n")).toContain(
      "file_count BETWEEN 1 AND 10000",
    );
    expect(sql.tagged.join("\n")).toContain(
      "App Builder repository Git preview capacity is invalid",
    );
    expect(sql.client.query).toHaveBeenCalledTimes(1);
  });
});

function sqlRecorder() {
  const queries: string[] = [];
  const tagged: string[] = [];
  const client = Object.assign(
    vi.fn(async (strings: TemplateStringsArray) => {
      tagged.push(strings.join("?"));
      return [];
    }),
    {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        return [];
      }),
    },
  ) as unknown as AppBuilderRepositorySchemaSqlClient;
  return { client, queries, tagged };
}
