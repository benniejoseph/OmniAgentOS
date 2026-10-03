"use client";
import type { ContentSearchGroup, ContentSearchProvider } from "@/lib/content-search/contracts";
import { contentSearchLabels } from "@/lib/content-search/model";
import type { PaletteSearchState } from "./content-search-state";
import styles from "./content-search.module.css";

export function ContentSearchResults({ state, listboxId, offset, currentIndex, onHighlight, onOpen }: {
  state: PaletteSearchState; listboxId: string; offset: number; currentIndex: number;
  onHighlight: (index: number) => void; onOpen: (href: string) => void;
}) {
  let index = offset;
  return state.groups.map((group) => <li key={group.provider} role="presentation" className={styles.group}>
    <div role="presentation" className={styles.heading}>{group.label}</div>
    <p role="presentation" className={styles.coverage}>{group.coverage}</p>
    <ul role="group" aria-label={group.label} className={styles.groupItems}>
      {group.items.map((item) => {
        const option = index++;
        return <li key={item.id} id={`${listboxId}-option-${option}`} role="option" aria-selected={option === currentIndex}
          onMouseEnter={() => onHighlight(option)} onClick={() => onOpen(item.href)}
          className={`${styles.option} ${option === currentIndex ? styles.selected : ""}`}>
          <span className={styles.title}>{item.title}</span><span className={styles.detail}>{item.detail}</span>
        </li>;
      })}
    </ul>
    {group.status === "unavailable" ? <p role="presentation" className={styles.message}>{group.message}</p> :
      group.items.length === 0 ? <p role="presentation" className={styles.message}>No matches in this scope.</p> : null}
  </li>);
}

export function ContentSearchPaging({ groups, loadingProvider, more }: {
  groups: ContentSearchGroup[]; loadingProvider: ContentSearchProvider | null; more: (provider: ContentSearchProvider) => void;
}) {
  return <div className={styles.paging} aria-label="Content result pages">
    {groups.filter((group) => group.nextCursor || group.status === "unavailable").map((group) =>
      <button key={group.provider} type="button" disabled={Boolean(loadingProvider) || group.items.length >= 100}
        onClick={() => more(group.provider)}>
        {loadingProvider === group.provider ? `Loading ${contentSearchLabels[group.provider]}…` :
          group.items.length >= 100 ? `100 ${contentSearchLabels[group.provider]} matches shown; refine search` :
          `${group.status === "unavailable" ? "Retry" : "More"} ${contentSearchLabels[group.provider]}`}
      </button>)}
  </div>;
}
