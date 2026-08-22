import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme/theme-provider";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "OmniAgentOS Operator Workspace",
    template: "%s | OmniAgentOS",
  },
  description: "Give an AI agent work, watch its progress, resolve approvals, and review evidence.",
};

const themeBootScript = `
(() => {
  try {
    const key = "omniagent-theme";
    const stored = localStorage.getItem(key) || "system";
    const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const resolved = stored === "system" ? (systemDark ? "dark" : "light") : stored;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = stored;
    document.documentElement.style.colorScheme = resolved;
  } catch {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.style.colorScheme = "dark";
  }
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-background text-foreground">
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        <ThemeProvider />
        {children}
      </body>
    </html>
  );
}
