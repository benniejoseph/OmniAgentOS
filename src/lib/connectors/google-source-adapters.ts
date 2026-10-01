import type { z } from "zod";
import type { sourceKindSchema } from "@/lib/sources/contracts";
import type {
  GoogleWorkspaceCapability,
  GoogleWorkspaceSyncSource,
} from "@/lib/connectors/google-workspace-capabilities";

/**
 * What each Google source the personal sync reads declares about itself: the
 * adapter its evidence names, the capability it reads under, the kind of item
 * it produces, and the largest page it may return. The sync reads these
 * declarations instead of repeating them, and the source conformance suite
 * holds every declared adapter to the same contract.
 */
export type GoogleSourceAdapter = Readonly<{
  source: GoogleWorkspaceSyncSource;
  adapterId: `google.personal_sync.${GoogleWorkspaceSyncSource}`;
  adapterVersionId: string;
  capability: GoogleWorkspaceCapability;
  sourceKind: z.infer<typeof sourceKindSchema>;
  /** The sync asks for no more items a page, and refuses a larger page. */
  pageLimit: number;
}>;

export const GOOGLE_SOURCE_ADAPTERS: Readonly<
  Record<GoogleWorkspaceSyncSource, GoogleSourceAdapter>
> = Object.freeze({
  mail: Object.freeze({
    source: "mail",
    adapterId: "google.personal_sync.mail",
    adapterVersionId: "1",
    capability: "gmail.read",
    sourceKind: "email",
    pageLimit: 5,
  }),
  calendar: Object.freeze({
    source: "calendar",
    adapterId: "google.personal_sync.calendar",
    adapterVersionId: "1",
    capability: "calendar.events.read",
    sourceKind: "calendar_event",
    pageLimit: 10,
  }),
  drive: Object.freeze({
    source: "drive",
    adapterId: "google.personal_sync.drive",
    adapterVersionId: "1",
    capability: "drive.read",
    sourceKind: "file",
    pageLimit: 3,
  }),
});
