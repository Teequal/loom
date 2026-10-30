"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * What you just picked (an option opened or used, a Develop step used) comes to the middle of the
 * screen, below the pinned box, and stays there: a glide in, then it follows quietly while the
 * page settles around it (other options going up in smoke, results arriving). Scrolling is held
 * meanwhile (not inside the inspector or Rules); a tap outside it, or Escape, lets the page scroll
 * freely again. `topInset` is where the free screen starts (the pinned box's bottom edge).
 */
export function useCenterLock(topInset: () => number) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const center = useCallback((target: HTMLElement | null | undefined) => setEl(target ?? null), []);
  const release = useCallback(() => setEl(null), []);

  useEffect(() => {
    if (!el) return;
    el.classList.add("centered");
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    // Where the page should be for it to sit in the middle of the free screen (or at the top of
    // it, when it's taller than that).
    const target = () => {
      const top = Math.max(0, topInset());
      const r = el.getBoundingClientRect();
      const room = window.innerHeight - top;
      const at = r.height < room - 24 ? top + (room - r.height) / 2 : top + 12;
      const y = window.scrollY + r.top - at;
      return Math.max(0, Math.min(y, document.documentElement.scrollHeight - window.innerHeight));
    };
    const from = window.scrollY;
    const t0 = performance.now();
    const GLIDE = 650;
    let raf = 0;
    const step = (now: number) => {
      if (!el.isConnected) return setEl(null);
      const t = Math.min(1, (now - t0) / GLIDE);
      const to = target();
      const y = t < 1 ? from + (to - from) * ease(t) : window.scrollY + (to - window.scrollY) * 0.18;
      if (Math.abs(y - window.scrollY) > 0.5) window.scrollTo(0, y);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    // Held: the page doesn't scroll under your fingers, except in panels that scroll themselves.
    const hold = (e: Event) => {
      if (!(e.target instanceof Element) || !e.target.closest("aside, [role=dialog]")) e.preventDefault();
    };
    const out = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !el.contains(e.target)) setEl(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEl(null);
    };
    window.addEventListener("wheel", hold, { passive: false });
    window.addEventListener("touchmove", hold, { passive: false });
    document.addEventListener("pointerdown", out, true);
    window.addEventListener("keydown", key);
    return () => {
      cancelAnimationFrame(raf);
      el.classList.remove("centered");
      window.removeEventListener("wheel", hold);
      window.removeEventListener("touchmove", hold);
      document.removeEventListener("pointerdown", out, true);
      window.removeEventListener("keydown", key);
    };
  }, [el, topInset]);

  return { center, release };
}
