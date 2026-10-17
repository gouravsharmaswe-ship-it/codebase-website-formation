/**
 * Personal Profile Card — Interaction Engine
 * - Theme switching with safe localStorage persistence and accessibility state
 * - Smooth pointer-following ambient glow behind card
 * - Image fallback handling if profile picture fails to load
 * - Respects prefers-reduced-motion
 */

(function () {
  'use strict';

  // --- DOM Elements ---
  const html = document.documentElement;
  const themeToggle = document.getElementById('themeToggle');
  const themeStatus = document.getElementById('themeStatus');
  const cardWrapper = document.getElementById('cardWrapper');
  const avatarImage = document.getElementById('avatarImage');
  const avatarFallback = document.getElementById('avatarFallback');

  // Check prefers-reduced-motion
  const reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let prefersReducedMotion = reduceMotionQuery.matches;

  reduceMotionQuery.addEventListener('change', (e) => {
    prefersReducedMotion = e.matches;
  });

  // --------------------------------------------------------------------------
  // 1. Safe LocalStorage Storage Utility
  // --------------------------------------------------------------------------
  const STORAGE_KEY = 'gourav_profile_theme';

  function getStoredTheme() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      // LocalStorage access may be restricted in private/sandboxed environments
      return null;
    }
  }

  function setStoredTheme(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (e) {
      // Gracefully ignore write failures
    }
  }

  // --------------------------------------------------------------------------
  // 2. Theme Switching Logic
  // --------------------------------------------------------------------------
  function applyTheme(theme) {
    html.setAttribute('data-theme', theme);
    const isDark = theme === 'dark';

    if (themeToggle) {
      themeToggle.setAttribute('aria-pressed', isDark ? 'false' : 'true');
      themeToggle.setAttribute(
        'aria-label',
        isDark ? 'Switch to light theme' : 'Switch to dark theme'
      );
    }

    if (themeStatus) {
      themeStatus.textContent = isDark ? 'Light mode' : 'Dark mode';
    }

    setStoredTheme(theme);
  }

  // Initialize theme from storage or system preference
  const savedTheme = getStoredTheme();
  if (savedTheme === 'light' || savedTheme === 'dark') {
    applyTheme(savedTheme);
  } else {
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(prefersDark ? 'dark' : 'light');
  }

  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const currentTheme = html.getAttribute('data-theme') || 'dark';
      const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
      applyTheme(nextTheme);
    });
  }

  // --------------------------------------------------------------------------
  // 3. Pointer-Responsive Ambient Glow (Mouse & Trackpad)
  // --------------------------------------------------------------------------
  let rafId = null;

  function handlePointerMove(e) {
    if (prefersReducedMotion || !cardWrapper) return;

    if (rafId) cancelAnimationFrame(rafId);

    rafId = requestAnimationFrame(() => {
      const rect = cardWrapper.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      cardWrapper.style.setProperty('--glow-x', `${x}px`);
      cardWrapper.style.setProperty('--glow-y', `${y}px`);
    });
  }

  function handlePointerLeave() {
    if (prefersReducedMotion || !cardWrapper) return;

    if (rafId) cancelAnimationFrame(rafId);

    // Reset glow to center smoothly
    rafId = requestAnimationFrame(() => {
      cardWrapper.style.setProperty('--glow-x', '50%');
      cardWrapper.style.setProperty('--glow-y', '50%');
    });
  }

  if (cardWrapper && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    cardWrapper.addEventListener('pointermove', handlePointerMove);
    cardWrapper.addEventListener('pointerleave', handlePointerLeave);
  }

  // --------------------------------------------------------------------------
  // 4. Graceful Profile Image Error Fallback
  // --------------------------------------------------------------------------
  function activateFallback() {
    if (avatarImage) avatarImage.classList.add('is-hidden');
    if (avatarFallback) avatarFallback.classList.add('is-visible');
  }

  if (avatarImage) {
    avatarImage.addEventListener('error', activateFallback);

    // If image source is empty or already failed to load
    if (!avatarImage.getAttribute('src') || (avatarImage.complete && avatarImage.naturalWidth === 0)) {
      activateFallback();
    }
  }

})();
