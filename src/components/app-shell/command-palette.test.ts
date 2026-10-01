import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { appNav } from "@/lib/navigation";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { CommandPalette, CommandPaletteResults } = await import(
  "@/components/app-shell/command-palette"
);

type OptionProps = Record<string, unknown> & { "aria-selected"?: boolean };

function results(query: string, currentIndex = 0) {
  const onHighlight = vi.fn();
  const onOpen = vi.fn();
  const items = query ? [] : appNav.slice(0, 3);
  const list = CommandPaletteResults({
    listboxId: "palette",
    query,
    results: items,
    currentIndex,
    onHighlight,
    onOpen,
  }) as ReactElement<{ children: ReactElement<OptionProps>[] | ReactElement<OptionProps> }>;
  return { items, list, onHighlight, onOpen };
}

describe("opening a workspace from the command palette", () => {
  it("opens an option on a click, and not as a touch lands on it", () => {
    const { items, list, onHighlight, onOpen } = results("", 1);
    const options = list.props.children as ReactElement<OptionProps>[];
    expect(options).toHaveLength(3);

    options.forEach((option, index) => {
      // Only hovering and clicking do anything; a pointer or touch going
      // down, as it does to scroll the list, does not.
      expect(Object.keys(option.props).filter((key) => key.startsWith("on")).sort())
        .toEqual(["onClick", "onMouseEnter"]);
      expect(option.props["aria-selected"]).toBe(index === 1);

      (option.props.onMouseEnter as () => void)();
      expect(onHighlight).toHaveBeenLastCalledWith(index);
      expect(onOpen).not.toHaveBeenCalled();
    });

    (options[2]!.props.onClick as () => void)();
    expect(onOpen.mock.calls).toEqual([[items[2]!.href]]);
  });

  it("lists each match as an option, and says when nothing matches", () => {
    const html = renderToStaticMarkup(results("").list);
    for (const [index, item] of appNav.slice(0, 3).entries()) {
      expect(html).toContain(`id="palette-option-${index}" role="option"`);
      expect(html).toContain(item.label);
    }

    const empty = renderToStaticMarkup(results("nowhere").list);
    expect(empty).not.toContain('role="option"');
    expect(empty).toContain("No workspace matches “nowhere”.");
  });

  it("starts closed, with only its trigger shown", () => {
    const html = renderToStaticMarkup(createElement(CommandPalette));
    expect(html).toContain('aria-label="Open command palette"');
    expect(html).not.toContain('role="listbox"');
  });
});
