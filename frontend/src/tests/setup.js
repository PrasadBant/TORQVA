import '@testing-library/jest-dom';
import { beforeEach } from 'vitest';

// Every test starts at the root URL: the app reads its page from the URL hash, so a route left by one test must not open another test's page.
beforeEach(() => { try { window.history.replaceState(null, '', '/'); } catch { /* not a browser environment */ } });

// Mock ResizeObserver for Recharts
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
