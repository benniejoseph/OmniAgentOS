import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Built with Asael", description: "A project built in Asael Studio." };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
