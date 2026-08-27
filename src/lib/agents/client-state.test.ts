import { describe, expect, it } from "vitest";
import { upsertById } from "@/lib/agents/client-state";

describe("upsertById", () => {
  it("adds the server-created record to the current roster", () => {
    expect(
      upsertById([{ id: "existing", name: "Existing" }], {
        id: "created",
        name: "Created",
      }),
    ).toEqual([
      { id: "existing", name: "Existing" },
      { id: "created", name: "Created" },
    ]);
  });

  it("replaces the edited record without changing roster order", () => {
    expect(
      upsertById(
        [
          { id: "first", name: "First" },
          { id: "edited", name: "Before" },
          { id: "last", name: "Last" },
        ],
        { id: "edited", name: "After" },
      ),
    ).toEqual([
      { id: "first", name: "First" },
      { id: "edited", name: "After" },
      { id: "last", name: "Last" },
    ]);
  });
});
