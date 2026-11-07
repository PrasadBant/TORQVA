import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';
import { beforeEach } from 'vitest';

// Most pages are code-split (React.lazy): the first open of a page imports its module, which under a full parallel test run can take
// longer than Testing Library's 1 s default. findBy*/waitFor get 5 s; a test that passes still returns as soon as its element appears.
configure({ asyncUtilTimeout: 5000 });

// Every test starts at the root URL: the app reads its page from the URL hash, so a route left by one test must not open another test's page.
beforeEach(() => { try { window.history.replaceState(null, '', '/'); } catch { /* not a browser environment */ } });

// Mock ResizeObserver for Recharts
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
