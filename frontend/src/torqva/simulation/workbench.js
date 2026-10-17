// Loads the analyst workbench plan (GET /simulation/workbench/plan) for the simulation pages. The plan is the backend's own reading of the
// live simulated run: C1 status, hypothesis evidence, expected information gain per C4 test, limits and suggested speeds. It is refreshed
// when simulation time advances (at most every few seconds), never on a timer of its own, so it adds no polling while the run is paused.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api.js';

const MIN_GAP_MS = 2500;

export function usePlan(d) {
  const t = d?.status?.t;
  const has = t !== undefined && t !== null;
  const [state, setState] = useState({ plan: null, error: null, loading: has });
  const busy = useRef(false); const last = useRef(0); const alive = useRef(true);
  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true; last.current = Date.now();
    try { const plan = await api.wbPlan(); if (alive.current) setState({ plan: plan && plan.provenance ? plan : null, error: plan && plan.provenance ? null : 'unavailable', loading: false }); }
    catch (e) { if (alive.current) setState((s) => ({ plan: s.plan, error: e instanceof ApiError ? e.message : String(e.message || e), loading: false })); }
    finally { busy.current = false; }
  }, []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!has) { setState({ plan: null, error: null, loading: false }); return undefined; }
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - last.current));
    const id = setTimeout(load, wait);
    return () => clearTimeout(id);
  }, [has, t, load]);
  return { ...state, reload: load };
}

export const fmtRpm = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Math.round(Number(v)).toLocaleString('en-US'));
export const title = (s) => String(s ?? '').replaceAll('_', ' ');
export const pct = (p, d = 0) => (p === null || p === undefined || !Number.isFinite(p) ? '—' : `${(p * 100).toFixed(d)}%`);
