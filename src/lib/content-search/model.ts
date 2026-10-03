export const contentSearchProviders = ["conversations", "work", "memory", "library"] as const;
export type ContentSearchProvider = typeof contentSearchProviders[number];
export const contentSearchLabels: Record<ContentSearchProvider, string> = {
  conversations: "Conversations", work: "Work", memory: "Private memory", library: "Library",
};
export const contentSearchCoverage: Record<ContentSearchProvider, string> = {
  conversations: "Your conversation titles.",
  work: "Your mapped projects and tasks in active workspaces. Archived projects and historical missions are excluded.",
  memory: "Your active private memories. Shared, historical, archived and working memory are excluded.",
  library: "Your captures, recordings, transcripts, project artifacts and currently authorized indexed sources. Unindexed or revoked connections are excluded.",
};
