"""Phase 9 - trusted healthy-session attestation for the EXPERIMENTAL adaptive C1 detector. SIMULATION ONLY.

What an attestation is: a named operator's recorded judgment that a recorded warm-up looked healthy, made after the system's
deterministic eligibility checks passed. It is NOT proof that the motor is fault-free and the UI/API say so. A session never becomes
trusted because it looks statistically normal: only an authorised human action moves ELIGIBLE -> ATTESTED, and the checks can only
ever *remove* eligibility (fail closed: missing or unreadable evidence fails the check).

Candidate lifecycle (`CState`)                         who / what causes it
  PENDING   evidence captured but incomplete           system: fewer than `min_windows` windows (nothing else failed)
  ELIGIBLE  every deterministic check passed           system
  ATTESTED  operator approved the recorded evidence    operator (server-enforced role >= operator), reason + acknowledgement
  REJECTED  not usable as a reference                  system (a check failed) or operator (reason required)
  EXPIRED   evidence went stale before a decision      system: too old, session ended, or an incident/e-stop/mandatory stop since capture
  REVOKED   previously attested, now withdrawn         operator (reason required): contamination suspected
  Allowed: PENDING->{ELIGIBLE,REJECTED,EXPIRED}  ELIGIBLE->{ATTESTED,REJECTED,EXPIRED}  ATTESTED->{REVOKED}.  REJECTED/EXPIRED/REVOKED are terminal.

Reference versions are immutable rows (DB triggers forbid UPDATE/DELETE). Building one validates it on held-out windows of the same
recording and with a synthetic-fault sensitivity probe. Activation only swaps `det.reference` of the live session; the trained bins,
the default detector, the Safety Supervisor and every command path are untouched. The Phase 8 final test seeds are not importable here.
"""
from __future__ import annotations

import hashlib
import json
import math
import threading
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np

from .c1_robust import (NONVIB_IDX, VIB_IDX, AdaptiveBaselineDetector, ReferenceConfig, ReferenceRegistry, SessionReference,
                        _estimate_nuisance, _probe, _steady_models)
from .schemas import Role
from .sim import FEATURES, Window
from .store import StaleRevision, Store
from .supervisor import mandatory_stop_reasons

_ORDER = {Role.VIEWER: 0, Role.OPERATOR: 1, Role.ADMIN: 2}


class CState(str, Enum):
    PENDING = "PENDING"
    ELIGIBLE = "ELIGIBLE"
    ATTESTED = "ATTESTED"
    REJECTED = "REJECTED"
    EXPIRED = "EXPIRED"
    REVOKED = "REVOKED"


TRANSITIONS = {CState.PENDING: {CState.ELIGIBLE, CState.REJECTED, CState.EXPIRED},
               CState.ELIGIBLE: {CState.ATTESTED, CState.REJECTED, CState.EXPIRED},
               CState.ATTESTED: {CState.REVOKED}, CState.REJECTED: set(), CState.EXPIRED: set(), CState.REVOKED: set()}

NOTICE = ("Attestation is an operator judgment about a recorded simulated session. It is not proof that the motor is fault-free "
          "and carries no physical validation.")


class AttestationError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


@dataclass
class AttestConfig:
    min_windows: int = 48
    capture_s: int = 60
    max_gap_s: float = 1.5
    max_stale_s: float = 3.0
    max_age_s: float = 300.0         # simulation seconds between capture and decision
    min_steady_frac: float = 0.9
    max_rpm_cv: float = 0.03
    max_setpoint_spread_frac: float = 0.01
    max_ambient_std_c: float = 1.0
    ambient_range_c: Tuple[float, float] = (5.0, 45.0)
    max_voltage_std_v: float = 0.25
    protected_median_z: float = 3.0  # current/duty/voltage/power/thermal channels: a shift here is never absorbed as a nuisance
    holdout_frac: float = 0.25
    holdout_max_flag: float = 0.05
    probe_min_flag: float = 0.7
    min_reason_chars: int = 10
    sample_points: int = 30


@dataclass
class Check:
    name: str
    passed: bool
    detail: str
    kind: str = "hard"               # hard = failure makes it REJECTED; completeness = failure keeps it PENDING


def _wdict(w: Window) -> Dict[str, Any]:
    d = asdict(w)
    d.pop("provenance", None)
    return {k: (None if (isinstance(v, float) and not math.isfinite(v)) else v) for k, v in d.items()}


def _wobj(d: Dict[str, Any]) -> Window:
    return Window(**{k: (float("nan") if v is None else v) for k, v in d.items()})


def evidence_hash(windows: List[Dict[str, Any]]) -> str:
    return hashlib.sha256(json.dumps(windows, sort_keys=True).encode()).hexdigest()[:20]


def summarize(ws: List[Window], cfg: AttestConfig) -> Dict[str, Any]:
    if not ws:
        return {"n": 0}
    f = lambda a: np.array([getattr(w, a) for w in ws], dtype=float)
    rpm, sp, amb, volt = f("rpm"), f("setpoint"), f("ambient"), f("voltage")
    step = max(len(ws) // cfg.sample_points, 1)
    return {"n": len(ws), "t_start": ws[0].t, "t_end": ws[-1].t, "setpoint_rpm_mean": float(np.nanmean(sp)),
            "rpm_mean": float(np.nanmean(rpm)), "rpm_cv": float(np.nanstd(rpm) / max(np.nanmean(rpm), 1.0)),
            "ambient_c_mean": float(np.nanmean(amb)), "ambient_c_std": float(np.nanstd(amb)),
            "voltage_v_mean": float(np.nanmean(volt)), "voltage_v_std": float(np.nanstd(volt)),
            "current_a_mean": float(np.nanmean(f("current"))), "housing_c_mean": float(np.nanmean(f("housing"))),
            "vib_rms_g_mean": float(np.nanmean(f("vib_rms"))),
            "series": [{"t": w.t, "rpm": w.rpm, "vib_rms": w.vib_rms, "current": w.current, "voltage": w.voltage, "housing": w.housing}
                       for w in ws[::step]]}


def holdout_validation(det: AdaptiveBaselineDetector, windows: List[Window], cfg: AttestConfig) -> Dict[str, Any]:
    """Separate validation set = the final `holdout_frac` of the SAME recording, never used to fit the candidate."""
    rows = [w for w in windows if det.steady(w)]
    k = int(len(rows) * (1 - cfg.holdout_frac))
    fit, hold = rows[:k], rows[k:]
    if len(hold) < 8:
        return {"ok": False, "reason": "holdout_too_small", "n_fit": len(fit), "n_holdout": len(hold)}
    p = ReferenceRegistry().propose(det, fit, trusted=True, cfg=ReferenceConfig())
    if not p.accepted:
        return {"ok": False, "reason": "candidate_rejected_on_fit:" + p.reason, "n_fit": len(fit), "n_holdout": len(hold)}
    flag = float(np.mean([det.score(w, p.reference).anomalous for w in hold]))
    probe = float(np.mean([det.score(_probe(w, 1.6), p.reference).anomalous for w in hold]))
    ok = flag <= cfg.holdout_max_flag and probe >= cfg.probe_min_flag
    return {"ok": ok, "reason": "ok" if ok else ("holdout_flagged_as_anomalous" if flag > cfg.holdout_max_flag else "sensitivity_lost"),
            "holdout_flag_frac": flag, "probe_flag_frac": probe, "n_fit": len(fit), "n_holdout": len(hold)}


def run_checks(det: AdaptiveBaselineDetector, ws: List[Window], ctx: Dict[str, Any], cfg: AttestConfig) -> Tuple[List[Check], List[str]]:
    """Deterministic eligibility. Anything missing/unreadable fails. Returns (checks, warnings)."""
    C: List[Check] = []
    warnings: List[str] = []
    add = lambda n, ok, d, kind="hard": C.append(Check(n, bool(ok), d, kind))
    n = len(ws)
    soft = "completeness" if n < cfg.min_windows else "hard"      # while the warm-up is still short these only mean "not yet"
    add("telemetry_complete", n >= cfg.min_windows, f"{n} windows, need >= {cfg.min_windows}", "completeness")
    finite = all(all(math.isfinite(float(getattr(w, a))) for a in ("rpm", "setpoint", "duty", "voltage", "current", "housing", "ambient",
                                                                    "vib_rms", "v1x", "v2x", "v3x", "vhf")) for w in ws) if ws else False
    add("telemetry_valid", bool(ws) and all(w.valid for w in ws) and finite, "all windows valid and finite" if ws else "no windows")
    gaps = [b.t - a.t for a, b in zip(ws, ws[1:])]
    add("telemetry_contiguous", bool(ws) and (not gaps or max(gaps) <= cfg.max_gap_s),
        f"largest gap {max(gaps):.1f}s" if gaps else "needs >= 2 windows")
    now = ctx.get("now")
    age = None if now is None or not ws else now - ws[-1].t
    add("telemetry_fresh", age is not None and age <= cfg.max_stale_s, "last window age unknown" if age is None else f"last window {age:.1f}s old")
    steady_frac = float(np.mean([det.steady(w) for w in ws])) if ws else 0.0
    add("steady_operating_point", steady_frac >= cfg.min_steady_frac, f"{steady_frac:.0%} steady windows", soft)
    if ws:
        sp = np.array([w.setpoint for w in ws]); rpm = np.array([w.rpm for w in ws])
        spread = float((sp.max() - sp.min()) / max(sp.mean(), 1.0)); cv = float(rpm.std() / max(rpm.mean(), 1.0))
        amb = np.array([w.ambient for w in ws]); vv = np.array([w.voltage for w in ws])
        add("consistent_operating_speed", sp.mean() > 0 and spread <= cfg.max_setpoint_spread_frac and cv <= cfg.max_rpm_cv,
            f"setpoint spread {spread:.1%}, rpm CV {cv:.1%}", soft)
        add("consistent_environment", amb.std() <= cfg.max_ambient_std_c and cfg.ambient_range_c[0] <= amb.mean() <= cfg.ambient_range_c[1]
            and vv.std() <= cfg.max_voltage_std_v, f"ambient {amb.mean():.1f}±{amb.std():.2f} C, supply std {vv.std():.2f} V", soft)
    else:
        add("consistent_operating_speed", False, "no windows"); add("consistent_environment", False, "no windows")
    need = ("incident_open", "incidents_in_interval", "estop", "mandatory", "source_session", "versions")
    missing = [k for k in need if ctx.get(k) is None]
    add("context_recorded", not missing, "source session, versions and live safety context recorded" if not missing else f"missing: {missing}")
    add("no_incident", ctx.get("incident_open") is False and ctx.get("incidents_in_interval") == 0,
        f"incident open={ctx.get('incident_open')}, incidents since window start={ctx.get('incidents_in_interval')}")
    add("no_mandatory_stop_or_estop", ctx.get("estop") is False and ctx.get("mandatory") == [] and ctx.get("hard_stops_in_interval") == 0,
        f"estop={ctx.get('estop')}, mandatory={ctx.get('mandatory')}, hard stops in interval={ctx.get('hard_stops_in_interval')}")
    rows, models, unlearned = _steady_models(det, ws)
    if len(rows) < 30:
        k = "completeness" if (unlearned == 0 and n < cfg.min_windows) else "hard"
        add("operating_region_known", False, f"only {len(rows)} steady windows inside learned speed bins ({unlearned} outside)", k)
        add("no_suspected_fault", False, "cannot assess without learned-bin evidence", k); add("sensor_envelope", False, "cannot assess", k)
        add("candidate_validates_on_holdout", False, "cannot assess", k)
    else:
        add("operating_region_known", unlearned / (unlearned + len(rows)) <= 0.2, f"{unlearned} windows outside learned speed bins")
        scores = [det.score(w, None) for w in rows]
        Z = np.array([s.z for s in scores if s.z is not None])
        pz = float(np.max(np.abs(np.median(Z, axis=0)[NONVIB_IDX]))) if len(Z) else float("inf")
        ok, reason, gain, nu, met = _estimate_nuisance(det, rows, models, ReferenceConfig())
        selective = (not ok) and reason == "incoherent_vibration_channels"
        add("no_suspected_fault", pz <= cfg.protected_median_z and not selective,
            f"protected-channel median |z|={pz:.2f}; vibration channels " + ("channel-selective (fault-like)" if selective else "coherent"))
        add("sensor_envelope", ok, "gain/noise within envelope and stationary" if ok else f"not explainable as a static nuisance: {reason}")
        if ok:
            if abs(math.log(gain)) >= 0.04 or float(np.max(nu)) > 1.0:
                warnings.append("healthy-looking common-mode shift (gain %.2f, noise x%.2f): indistinguishable from a sensor gain fault; "
                                "the operator must judge" % (gain, float(np.max(nu))))
            hv = holdout_validation(det, ws, cfg)
            add("candidate_validates_on_holdout", hv["ok"], json.dumps({k: (round(v, 3) if isinstance(v, float) else v) for k, v in hv.items()}))
        else:
            add("candidate_validates_on_holdout", False, "no candidate could be built")
    return C, warnings


def classify(checks: List[Check]) -> Tuple[CState, List[str]]:
    hard = [c for c in checks if not c.passed and c.kind == "hard"]
    soft = [c for c in checks if not c.passed and c.kind == "completeness"]
    if hard:
        return CState.REJECTED, [f"{c.name}: {c.detail}" for c in hard]
    if soft:
        return CState.PENDING, [f"{c.name}: {c.detail}" for c in soft]
    return CState.ELIGIBLE, []


class AttestationService:
    """All privileged operations. The API layer authenticates; this layer RE-CHECKS the role (defence in depth), enforces the state
    machine and compare-and-set revisions, and writes every change atomically with its audit row."""

    def __init__(self, store: Store, cfg: Optional[AttestConfig] = None):
        self.store, self.cfg = store, cfg or AttestConfig()
        self._lock = threading.RLock()
        self._active_stack: Dict[str, List[int]] = {}

    # ---------------- helpers ----------------
    @staticmethod
    def _need_operator(role: Role) -> None:
        if _ORDER[role] < _ORDER[Role.OPERATOR]:
            raise AttestationError(403, "requires role operator")

    def _reason(self, reason: Optional[str]) -> str:
        r = (reason or "").strip()
        if len(r) < self.cfg.min_reason_chars:
            raise AttestationError(422, f"a reason of at least {self.cfg.min_reason_chars} characters is required")
        return r

    def _doc(self, cid: str) -> Dict[str, Any]:
        d = self.store.get("attestation_candidate", cid)
        if d is None:
            raise AttestationError(404, "no such candidate")
        d.pop("_provenance", None)
        return d

    def _save(self, doc: Dict[str, Any], event: str, actor: str, role: str, expect_rev: Optional[int], to: Optional[CState] = None,
              reason: str = "", extra: Optional[Dict] = None, ref_version: Optional[Dict] = None) -> Dict[str, Any]:
        frm = doc["state"]
        if to is not None:
            if CState(to) not in TRANSITIONS[CState(frm)]:
                raise AttestationError(409, f"illegal transition {frm} -> {CState(to).value}")
            doc["state"] = CState(to).value
        doc["rev"] = (expect_rev if expect_rev is not None else doc.get("rev", 0)) + 1
        entry = {"event": event, "from": frm, "to": doc["state"], "by": actor, "role": role, "reason": reason, "sim_t": doc.get("sim_t_now"),
                 "rev": doc["rev"], **(extra or {})}
        doc.setdefault("history", []).append(entry)
        detail = {"event": event, "candidate": doc["id"], "from_state": frm, "to_state": doc["state"], "reason": reason, "role": role,
                  "session": doc["session"], "evidence_hash": doc["evidence_hash"], "versions": doc["versions"], "sim_t": doc.get("sim_t_now"),
                  "reference_version": doc.get("reference_version"), "operator_judgment_only": True, **(extra or {})}
        try:
            self.store.put_audited("attestation_candidate", doc["id"], doc, "HUMAN_CONFIRMED" if doc["state"] == "ATTESTED" else "SIMULATED",
                                   "attestation", actor, detail, expect_rev=expect_rev, ref_version=ref_version)
        except StaleRevision as e:
            raise AttestationError(409, f"candidate changed concurrently: {e}")
        return doc

    def _live_ctx(self, orch, since_t: float) -> Dict[str, Any]:
        log = orch.log
        inc = sum(1 for l in log if l.get("kind") == "incident_opened" and l.get("t", 0) >= since_t) + \
            sum(1 for l in log if l.get("kind") == "transition" and l.get("event") == "DEVICE_ESTOP" and l.get("t", 0) >= since_t)
        hard = sum(1 for l in log if l.get("kind") == "mandatory_stop" and l.get("t", 0) >= since_t)
        return {"now": orch.now, "incident_open": orch.inc is not None, "incidents_in_interval": inc, "hard_stops_in_interval": hard,
                "estop": bool(orch.dev.estop), "mandatory": mandatory_stop_reasons(orch._ctx(), orch.sup.limits)}

    def _versions(self, orch, scenario: Dict[str, Any]) -> Dict[str, Any]:
        cfgh = hashlib.sha256(json.dumps(asdict(self.cfg), sort_keys=True, default=str).encode()).hexdigest()[:12]
        return {"detector_class": type(orch.det).__name__, "detector_version": orch.det.version,
                "hypothesis_model": getattr(orch.hm, "version", None), "attestation_config": cfgh, "scenario": scenario}

    # ---------------- capture / evaluate ----------------
    def capture(self, orch, scenario: Dict[str, Any], user: str, role: Role) -> Dict[str, Any]:
        self._need_operator(role)
        if orch is None:
            raise AttestationError(409, "no simulation running")
        if not isinstance(orch.det, AdaptiveBaselineDetector):
            raise AttestationError(409, "detector does not support session references")
        with self._lock:
            n = len(self.store.list("attestation_candidate")) + 1
            cid = f"C-{n:04d}"
            doc = {"id": cid, "rev": 0, "session": orch.session, "created_by": user, "state": CState.PENDING.value, "history": [],
                   "notice": NOTICE, "provenance": "SIMULATED"}
            self._evaluate_into(doc, orch, scenario)
            return self._save(doc, "candidate_captured", user, role.value, None, to=None, reason="",
                              extra={"checks_failed": [c["name"] for c in doc["checks"] if not c["passed"]]})

    def _evaluate_into(self, doc, orch, scenario) -> None:
        ws = [w for w in orch.buf[-self.cfg.capture_s:]]
        t0 = ws[0].t if ws else orch.now
        ctx = {**self._live_ctx(orch, t0), "source_session": orch.session, "versions": self._versions(orch, scenario)}
        checks, warnings = run_checks(orch.det, ws, ctx, self.cfg)
        state, why = classify(checks)
        doc.update({"windows": [_wdict(w) for w in ws], "evidence_hash": evidence_hash([_wdict(w) for w in ws]),
                    "summary": summarize(ws, self.cfg), "checks": [asdict(c) for c in checks], "warnings": warnings,
                    "reasons": why, "versions": ctx["versions"], "captured_sim_t": orch.now, "sim_t_now": orch.now})
        doc["state"] = state.value                      # initial classification (capture / refresh); decisions go through _save

    def refresh(self, cid: str, orch, scenario: Dict[str, Any], user: str, role: Role, expect_rev: Optional[int]) -> Dict[str, Any]:
        """Re-capture the latest windows of a PENDING candidate (more warm-up has accrued)."""
        self._need_operator(role)
        with self._lock:
            doc = self._doc(cid)
            self._sweep_one(doc, orch)
            doc = self._doc(cid)
            if doc["state"] != CState.PENDING.value:
                raise AttestationError(409, f"only PENDING candidates can be refreshed (is {doc['state']})")
            if orch is None or orch.session != doc["session"]:
                raise AttestationError(409, "the source session is no longer running")
            rev = doc["rev"] if expect_rev is None else expect_rev
            if rev != doc["rev"]:
                raise AttestationError(409, "candidate changed concurrently")
            old = doc["state"]
            self._evaluate_into(doc, orch, scenario)
            new = doc["state"]; doc["state"] = old                 # let _save apply the checked transition
            if new == old:
                return self._save(doc, "candidate_refreshed", user, role.value, rev, to=None, reason="still pending")
            return self._save(doc, "candidate_evaluated", user, role.value, rev, to=CState(new), reason="; ".join(doc["reasons"]))

    # ---------------- expiry (lazy, system actor) ----------------
    def _stale_reason(self, doc, orch) -> Optional[str]:
        if doc["state"] not in (CState.PENDING.value, CState.ELIGIBLE.value):
            return None
        if orch is None or orch.session != doc["session"]:
            return "source session is no longer running"
        if orch.now - doc["captured_sim_t"] > self.cfg.max_age_s:
            return f"evidence older than {self.cfg.max_age_s:.0f} simulated seconds"
        c = self._live_ctx(orch, doc["captured_sim_t"] - self.cfg.capture_s)
        if c["incident_open"] or c["incidents_in_interval"] or c["hard_stops_in_interval"] or c["estop"] or c["mandatory"]:
            return "incident / e-stop / mandatory-stop condition since capture"
        return None

    def _sweep_one(self, doc, orch) -> None:
        why = self._stale_reason(doc, orch)
        if why:
            doc["sim_t_now"] = orch.now if orch else doc.get("sim_t_now")
            try:
                self._save(doc, "expired", "system", "system", doc["rev"], to=CState.EXPIRED, reason=why)
            except AttestationError:
                pass

    def sweep(self, orch) -> None:
        with self._lock:
            for d in self.store.list("attestation_candidate"):
                d.pop("_provenance", None)
                self._sweep_one(d, orch)

    # ---------------- decisions ----------------
    def _decide_guard(self, cid: str, orch, expect_rev: Optional[int]) -> Dict[str, Any]:
        doc = self._doc(cid)
        if expect_rev is None:
            raise AttestationError(422, "expected_rev is required")
        if doc["rev"] != expect_rev:
            raise AttestationError(409, f"candidate changed (rev {doc['rev']}, you saw {expect_rev})")
        self._sweep_one(doc, orch)
        return self._doc(cid)

    def attest(self, cid: str, orch, user: str, role: Role, reason: str, acknowledged: bool, expect_rev: Optional[int]) -> Dict[str, Any]:
        self._need_operator(role)
        reason = self._reason(reason)
        if acknowledged is not True:
            raise AttestationError(422, "you must acknowledge that attestation is an operator judgment, not physical proof of health")
        with self._lock:
            doc = self._decide_guard(cid, orch, expect_rev)
            if doc["state"] == CState.EXPIRED.value:
                raise AttestationError(409, "evidence expired: " + doc["history"][-1].get("reason", ""))
            if doc["state"] != CState.ELIGIBLE.value:
                raise AttestationError(409, f"only ELIGIBLE candidates can be attested (is {doc['state']})")
            if [c for c in doc["checks"] if not c["passed"]]:
                raise AttestationError(409, "candidate has failed checks")          # belt and braces
            ws = [_wobj(w) for w in doc["windows"]]
            if evidence_hash(doc["windows"]) != doc["evidence_hash"]:
                raise AttestationError(409, "evidence hash mismatch: stored evidence was altered")
            p = ReferenceRegistry().propose(orch.det, ws, trusted=True, cfg=ReferenceConfig())
            hv = holdout_validation(orch.det, ws, self.cfg)
            doc["sim_t_now"] = orch.now
            if not p.accepted or not hv["ok"]:
                why = "reference_build_failed:" + (p.reason if not p.accepted else "holdout:" + hv["reason"])
                self._save(doc, "attest_blocked_by_validation", user, role.value, expect_rev, to=CState.REJECTED, reason=why)
                raise AttestationError(409, "the reference could not be validated: " + why)
            version = max([v["version"] for v in self.store.ref_versions()] or [0]) + 1
            ref = {"version": version, "candidate": cid, "session": doc["session"], "gain": p.reference.gain, "nu": list(p.reference.nu),
                   "n_warmup": p.reference.n_warmup, "metrics": p.metrics, "validation": hv, "status": "VALIDATED",
                   "detector_version": orch.det.version, "created_by": user, "evidence_hash": doc["evidence_hash"], "immutable": True}
            doc["reference_version"] = version
            doc["decision"] = {"by": user, "role": role.value, "reason": reason, "acknowledged_operator_judgment_only": True}
            return self._save(doc, "attested", user, role.value, expect_rev, to=CState.ATTESTED, reason=reason,
                              extra={"reference_version": version}, ref_version=ref)

    def reject(self, cid: str, orch, user: str, role: Role, reason: str, expect_rev: Optional[int]) -> Dict[str, Any]:
        self._need_operator(role)
        reason = self._reason(reason)
        with self._lock:
            doc = self._decide_guard(cid, orch, expect_rev)
            if doc["state"] not in (CState.ELIGIBLE.value, CState.PENDING.value):
                raise AttestationError(409, f"cannot reject a candidate that is {doc['state']}")
            doc["decision"] = {"by": user, "role": role.value, "reason": reason}
            return self._save(doc, "rejected", user, role.value, expect_rev, to=CState.REJECTED, reason=reason)

    def revoke(self, cid: str, orch, user: str, role: Role, reason: str, expect_rev: Optional[int]) -> Dict[str, Any]:
        self._need_operator(role)
        reason = self._reason(reason)
        with self._lock:
            doc = self._decide_guard(cid, orch, expect_rev)
            if doc["state"] != CState.ATTESTED.value:
                raise AttestationError(409, f"only ATTESTED candidates can be revoked (is {doc['state']})")
            v = doc.get("reference_version")
            stack = self._stack(doc["session"])
            was_active = bool(stack) and stack[-1] == v
            doc["sim_t_now"] = orch.now if orch else doc.get("sim_t_now")
            doc["revocation"] = {"by": user, "role": role.value, "reason": reason, "was_active": was_active}
            out = self._save(doc, "revoked", user, role.value, expect_rev, to=CState.REVOKED, reason=reason,
                             extra={"reference_version": v, "was_active": was_active})          # atomic with its audit row; may raise
            if v in stack:                                       # side effects only after the record + audit committed
                stack.remove(v)
                self._push_state(doc["session"])
            if orch is not None and orch.session == doc["session"] and was_active:
                orch.det.reference = self._ref_obj(stack[-1]) if stack else None
                orch._log("c1_reference", event="revoked_deactivated", version=v, reason=reason, metrics={})
            return out

    # ---------------- reference activation / rollback ----------------
    def _stack(self, session: str) -> List[int]:
        if session not in self._active_stack:
            d = self.store.get("reference_state", session)
            self._active_stack[session] = list(d["stack"]) if d else []
        return self._active_stack[session]

    def _push_state(self, session: str) -> None:
        d = self.store.get("reference_state", session) or {}
        body = {"session": session, "stack": list(self._active_stack[session]), "rev": d.get("rev", 0) + 1}
        self.store.put("reference_state", session, body, "SIMULATED")

    def _ref_obj(self, version: int) -> SessionReference:
        v = next(x for x in self.store.ref_versions() if x["version"] == version)
        return SessionReference(version, v["gain"], tuple(v["nu"]), v["n_warmup"])

    def activate(self, version: int, orch, user: str, role: Role, reason: str) -> Dict[str, Any]:
        self._need_operator(role)
        reason = self._reason(reason)
        with self._lock:
            v = next((x for x in self.store.ref_versions() if x["version"] == version), None)
            if v is None:
                raise AttestationError(404, "no such reference version")
            if v["status"] != "VALIDATED":
                raise AttestationError(409, "only VALIDATED references can be activated")
            cand = self._doc(v["candidate"])
            if cand["state"] != CState.ATTESTED.value:
                raise AttestationError(409, f"its candidate is {cand['state']}: only ATTESTED candidates can be activated")
            if orch is None or orch.session != v["session"]:
                raise AttestationError(409, "a reference only applies to the session it was recorded in, and that session is not running")
            if not isinstance(orch.det, AdaptiveBaselineDetector):
                raise AttestationError(409, "detector does not support session references")
            stack = self._stack(v["session"])
            if stack and stack[-1] == version:
                raise AttestationError(409, "already active")
            stack.append(version)
            try:
                self.store.put_audited("reference_state", v["session"], {"session": v["session"], "stack": list(stack),
                                       "rev": (self.store.get("reference_state", v["session"]) or {}).get("rev", 0) + 1}, "SIMULATED",
                                       "attestation", user, {"event": "reference_activated", "reference_version": version, "role": role.value,
                                                             "reason": reason, "stack": list(stack), "candidate": v["candidate"],
                                                             "session": v["session"], "operator_judgment_only": True})
            except BaseException:
                stack.pop()
                raise
            orch.det.reference = self._ref_obj(version)            # a swap of the reference only: trained bins are never modified
            orch._log("c1_reference", event="activated", version=version, reason=reason, metrics={})
            return {"active_version": version, "stack": list(stack)}

    def rollback(self, orch, user: str, role: Role, reason: str) -> Dict[str, Any]:
        self._need_operator(role)
        reason = self._reason(reason)
        with self._lock:
            if orch is None:
                raise AttestationError(409, "no simulation running")
            stack = self._stack(orch.session)
            if not stack:
                raise AttestationError(409, "no active reference to roll back")
            popped = stack.pop()
            try:
                self.store.put_audited("reference_state", orch.session, {"session": orch.session, "stack": list(stack),
                                       "rev": (self.store.get("reference_state", orch.session) or {}).get("rev", 0) + 1}, "SIMULATED",
                                       "attestation", user, {"event": "reference_rolled_back", "from_version": popped,
                                                             "to_version": stack[-1] if stack else None, "role": role.value, "reason": reason,
                                                             "session": orch.session, "operator_judgment_only": True})
            except BaseException:
                stack.append(popped)
                raise
            orch.det.reference = self._ref_obj(stack[-1]) if stack else None
            orch._log("c1_reference", event="rolled_back", version=popped, reason=reason, metrics={})
            return {"rolled_back": popped, "active_version": stack[-1] if stack else None}

    # ---------------- views ----------------
    @staticmethod
    def brief(d: Dict[str, Any]) -> Dict[str, Any]:
        return {"id": d["id"], "state": d["state"], "rev": d["rev"], "session": d["session"], "created_by": d["created_by"],
                "captured_sim_t": d["captured_sim_t"], "n": d["summary"].get("n"), "failed_checks": [c["name"] for c in d["checks"] if not c["passed"]],
                "reasons": d["reasons"], "warnings": d["warnings"], "reference_version": d.get("reference_version"),
                "setpoint_rpm": d["summary"].get("setpoint_rpm_mean"), "provenance": "SIMULATED"}

    def list(self, orch) -> List[Dict[str, Any]]:
        self.sweep(orch)
        out = []
        for d in self.store.list("attestation_candidate"):
            d.pop("_provenance", None)
            out.append(self.brief(d))
        return out

    def detail(self, cid: str, orch) -> Dict[str, Any]:
        self.sweep(orch)
        d = self._doc(cid)
        d.pop("windows", None)                                  # raw windows stay server-side; the summary + series are enough to review
        d["notice"] = NOTICE
        return d

    def references(self, orch) -> Dict[str, Any]:
        stack = self._stack(orch.session) if orch is not None else []
        return {"versions": [{k: v for k, v in x.items()} for x in self.store.ref_versions()], "active_stack": list(stack),
                "active_version": stack[-1] if stack else None, "session": orch.session if orch is not None else None,
                "notice": NOTICE}

    def events(self, cid: Optional[str] = None) -> List[Dict[str, Any]]:
        rows = self.store.audit_log("attestation")
        return [r for r in rows if cid is None or r["detail"].get("candidate") == cid]
