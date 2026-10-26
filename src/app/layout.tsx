import type { Metadata } from "next";
import { headers } from "next/headers";
import localFont from "next/font/local";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { WebVitalsReporter } from "@/components/performance/web-vitals-reporter";
import { PwaRegistrar } from "@/components/pwa-registrar";
import { ASAEL_PUBLIC_ORIGIN } from "@/lib/identity";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/geist-latin.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: "swap",
});

const geistMono = localFont({
  src: "./fonts/geist-mono-latin.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(ASAEL_PUBLIC_ORIGIN),
  title: {
    default: "Asael — Your personal AI partner",
    template: "%s | Asael",
  },
  description: "A personal AI partner for real work across your life and projects.",
  applicationName: "Asael",
  openGraph: {
    title: "Asael — Your personal AI partner",
    description: "A personal AI partner for real work across your life and projects.",
    images: [{ url: "/asael-logo.png", width: 1200, height: 800, alt: "Asael" }],
  },
};

const themeBootScript = `
(() => {
  try {
    const key = "asael-theme";
    const legacyKey = "omniagent-theme";
    const stored = localStorage.getItem(key) || localStorage.getItem(legacyKey) || "system";
    if (!localStorage.getItem(key) && localStorage.getItem(legacyKey)) {
      localStorage.setItem(key, stored);
      localStorage.removeItem(legacyKey);
    }
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

export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const nonce = (await headers()).get("x-nonce") || undefined;
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-background text-foreground">
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        <ThemeProvider />
        <WebVitalsReporter />
        <PwaRegistrar />
        {children}
      </body>
    </html>
  );
}
