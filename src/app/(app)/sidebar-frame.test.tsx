import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NavLinks } from "./nav-links";
import { SidebarFrame } from "./sidebar-frame";
import { ThemeToggle } from "./theme-toggle";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("next/link", () => ({
  default: ({ href, ...props }: ComponentProps<"a">) => <a href={href} {...props} />,
}));

let systemDark = false;
let narrowScreen = false;
const viewportListeners = new Set<() => void>();
beforeEach(() => {
  systemDark = false;
  narrowScreen = false;
  viewportListeners.clear();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() { return query.includes("max-width") ? narrowScreen : query.includes("dark") && systemDark; },
    addEventListener: (_event: string, listener: () => void) => { if (query.includes("max-width")) viewportListeners.add(listener); },
    removeEventListener: (_event: string, listener: () => void) => { if (query.includes("max-width")) viewportListeners.delete(listener); },
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
  document.cookie = "dossier_theme=; max-age=0; path=/";
  document.cookie = "dossier_sidebar=; max-age=0; path=/";
});

function renderSidebar(initialCollapsed = false) {
  return render(
    <SidebarFrame initialCollapsed={initialCollapsed} brand={<span>Dossier</span>}>
      <NavLinks />
      <ThemeToggle />
    </SidebarFrame>,
  );
}

describe("SidebarFrame", () => {
  it("collapses to icons, keeps every link named, and remembers it", async () => {
    renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    expect(screen.getByRole("complementary")).toHaveAttribute("data-collapsed", "true");
    // The labels are only visually hidden, so links keep their names.
    expect(screen.getByRole("link", { name: "Applications" })).toHaveAttribute("title", "Applications");
    expect(document.cookie).toContain("dossier_sidebar=collapsed");

    await userEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(screen.getByRole("complementary")).not.toHaveAttribute("data-collapsed");
    expect(document.cookie).toContain("dossier_sidebar=expanded");
  });

  it("starts collapsed when it was left that way", () => {
    renderSidebar(true);
    expect(screen.getByRole("complementary")).toHaveAttribute("data-collapsed", "true");
  });

  it("starts with an icon rail on mobile and leaves the desktop preference alone", async () => {
    narrowScreen = true;
    document.cookie = "dossier_sidebar=expanded; path=/";
    renderSidebar();
    const sidebar = screen.getByRole("complementary");
    expect(sidebar).toHaveAttribute("data-collapsed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(sidebar).not.toHaveAttribute("data-collapsed");
    expect(sidebar).toHaveClass("fixed");
    await userEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(sidebar).toHaveAttribute("data-collapsed", "true");
    expect(document.cookie).toContain("dossier_sidebar=expanded");

    act(() => { narrowScreen = false; viewportListeners.forEach((listener) => listener()); });
    expect(sidebar).not.toHaveAttribute("data-collapsed");
    expect(sidebar).toHaveClass("sticky");
  });

  it("restores a collapsed desktop preference after resizing through mobile", async () => {
    renderSidebar(true);
    act(() => { narrowScreen = true; viewportListeners.forEach((listener) => listener()); });
    await userEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    act(() => { narrowScreen = false; viewportListeners.forEach((listener) => listener()); });
    expect(screen.getByRole("complementary")).toHaveAttribute("data-collapsed", "true");
    expect(document.cookie).not.toContain("dossier_sidebar=expanded");
  });
});

describe("ThemeToggle", () => {
  it("offers the other scheme to the system's, then switches and remembers", async () => {
    renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "Dark mode" }));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.cookie).toContain("dossier_theme=dark");
    await userEvent.click(screen.getByRole("button", { name: "Light mode" }));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("follows a dark system until a choice is made", () => {
    systemDark = true;
    renderSidebar();
    expect(screen.getByRole("button", { name: "Light mode" })).toBeInTheDocument();
  });
});
