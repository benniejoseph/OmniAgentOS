"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Menu, X } from "lucide-react";
import { marketingActions, marketingNav } from "@/lib/marketing-content";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { AsaelMark } from "@/components/brand/asael-mark";
import styles from "./public-surface.module.css";

/** The default retains the fixed header expected by the separate Demo page. */
export function PublicHeader({ inFlow = false }: { inFlow?: boolean } = {}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setMobileOpen(false), 0);
    return () => window.clearTimeout(timer);
  }, [pathname]);
  useEffect(() => {
    if (!mobileOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") { setMobileOpen(false); menuButtonRef.current?.focus(); }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);
  const links = marketingNav.map((item) => <Link key={item.href} href={item.href} prefetch={false}
    aria-current={pathname === item.href ? "page" : undefined} className={styles.navLink}
    onClick={() => setMobileOpen(false)}>{item.label}</Link>);
  return <header className={`${styles.header} ${inFlow ? "" : styles.fixedHeader}`} data-public-header={inFlow ? "flow" : "fixed"}>
    <div className={styles.headerInner}>
      <Link href="/" prefetch={false} className={styles.brand} aria-label="Asael home"><AsaelMark size={36} priority className={styles.mark} /><span>Asael</span></Link>
      <nav className={styles.desktopNav} aria-label="Public navigation">{links}</nav>
      <div className={styles.headerActions}>
        <ThemeToggle compact />
        <Link href={marketingActions.signIn.href} prefetch={false} className={`${styles.primaryButton} ${styles.headerSignIn}`}>{marketingActions.signIn.label}<ArrowRight size={16} aria-hidden="true" /></Link>
        <button ref={menuButtonRef} type="button" className={`${styles.button} ${styles.menuButton}`}
          onClick={() => setMobileOpen((current) => !current)} aria-label={mobileOpen ? "Close public navigation" : "Open public navigation"}
          aria-expanded={mobileOpen} aria-controls="public-mobile-navigation">{mobileOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}</button>
      </div>
    </div>
    {mobileOpen ? <nav id="public-mobile-navigation" aria-label="Public navigation" className={styles.mobileNav}>
      <div className={styles.mobileLinks}>{links}<Link href={marketingActions.signIn.href} prefetch={false} className={styles.primaryButton}>{marketingActions.signIn.label}<ArrowRight size={16} aria-hidden="true" /></Link></div>
    </nav> : null}
  </header>;
}
