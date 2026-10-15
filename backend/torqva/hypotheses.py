"""Fault hypothesis ranking: class-conditional Gaussians over the signed z-score vector produced by C1.

Signatures are LEARNED from labelled windows (healthy-baseline z-scores under each injected fault), not
hand-tuned; priors and likelihoods can be refit from verified outcomes (C6). With little data the model
stays honest: temperature-scaled likelihood and an effective-sample cap keep the posterior from being
over-confident.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence

import numpy as np

from .schemas import Hypothesis

HYPS = list(Hypothesis)


@dataclass
class Posterior:
    probs: Dict[Hypothesis, float]
    n_windows: int
    ood: bool = False          # evidence does not look like ANY learned signature (unfamiliar): never 'confident'
    conflict: bool = False     # Phase 10: the latest test evidence ALONE confidently disagrees with the prior-driven top hypothesis: never 'confident'
    uncorroborated: bool = False   # Phase 11: the test's own likelihood does not support the top hypothesis (the prior decided): never 'confident'

    def ranked(self):
        return sorted(self.probs.items(), key=lambda kv: kv[1], reverse=True)

    @property
    def top(self) -> Hypothesis:
        return self.ranked()[0][0]

    @property
    def top_p(self) -> float:
        return self.ranked()[0][1]

    @property
    def margin(self) -> float:
        r = self.ranked()
        return r[0][1] - r[1][1]

    @property
    def entropy(self) -> float:
        p = np.array(list(self.probs.values()))
        p = p[p > 0]
        return float(-(p * np.log(p)).sum())

    def label(self, p_conf: float = 0.7, margin: float = 0.3) -> str:
        if self.n_windows < 3:
            return "insufficient"
        if self.ood:
            return "unfamiliar"
        if self.conflict:
            return "conflicted"
        if self.uncorroborated:
            return "uncorroborated"
        return "confident" if (self.top_p >= p_conf and self.margin >= margin) else "ambiguous"


class HypothesisModel:
    def __init__(self, max_effective_windows: int = 8, temperature: float = 1.0):
        self.mu: Dict[Hypothesis, np.ndarray] = {}
        self.var: Dict[Hypothesis, np.ndarray] = {}
        self.prior: Dict[Hypothesis, float] = {h: 1.0 / len(HYPS) for h in HYPS}
        self.max_eff = max_effective_windows
        self.ood_slack = 3.0
        self.temp = temperature
        self.version = 0
        self._hist: List[tuple] = []
        self.ood_thr: Dict[Hypothesis, float] = {}
        self.use_ood = True

    def fit(self, samples: Dict[Hypothesis, Sequence[np.ndarray]], priors: Optional[Dict[Hypothesis, float]] = None) -> int:
        self._hist.append((copy.deepcopy(self.mu), copy.deepcopy(self.var), dict(self.prior)))
        for h, zs in samples.items():
            if len(zs) < 5:
                continue
            Z = np.vstack(zs)
            # clip so one wild feature (e.g. a 100-sigma harmonic) doesn't dominate; signature is its *direction*
            Z = np.clip(Z, -30, 30)
            self.mu[h] = Z.mean(axis=0)
            self.var[h] = Z.var(axis=0) + 1.0        # +1: floor at unit (healthy) variance
            lls = self._logliks(h, Z)
            # 1st percentile of per-window log-likelihood on the training evidence, minus slack: below this = unfamiliar
            self.ood_thr[h] = float(np.percentile(lls, 1) - self.ood_slack)
        if priors:
            tot = sum(priors.values())
            self.prior = {h: priors.get(h, 0.0) / tot for h in HYPS}
        self.version += 1
        return self.version

    def rollback(self) -> int:
        mu, var, pr = self._hist.pop()
        self.mu, self.var, self.prior = mu, var, pr
        self.version += 1
        return self.version

    def _loglik(self, h: Hypothesis, z: np.ndarray) -> float:
        return float(self._logliks(h, np.asarray(z)[None, :])[0])

    def _logliks(self, h: Hypothesis, Z: np.ndarray) -> np.ndarray:
        """Per-window log-likelihood of each row of Z under h (one numpy pass instead of one call per window)."""
        Z = np.clip(Z, -30, 30)
        mu, var = self.mu[h], self.var[h]
        return -0.5 * np.sum((Z - mu) ** 2 / var + np.log(var), axis=1)

    def _mean_loglik(self, zs: Sequence[np.ndarray], hs: List[Hypothesis]) -> np.ndarray:
        Z = np.vstack(zs)
        return np.array([np.mean(self._logliks(h, Z)) for h in hs])                # mean per window

    def posterior(self, zs: Sequence[np.ndarray], prior: Optional[Dict[Hypothesis, float]] = None) -> Posterior:
        hs = [h for h in HYPS if h in self.mu]
        if not zs or not hs:
            return Posterior({h: 1.0 / len(HYPS) for h in HYPS}, 0)
        return self._posterior(self._mean_loglik(zs, hs), hs, len(zs), prior)

    def _posterior(self, ll: np.ndarray, hs: List[Hypothesis], n: int, prior: Optional[Dict[Hypothesis, float]] = None) -> Posterior:
        pr = prior or self.prior
        n_eff = min(n, self.max_eff)                                               # cap evidence from correlated windows
        logp = np.log(np.array([max(pr[h], 1e-9) for h in hs])) + n_eff * ll / self.temp
        logp -= logp.max()
        p = np.exp(logp)
        p /= p.sum()
        probs = {h: 0.0 for h in HYPS}
        probs.update({h: float(pi) for h, pi in zip(hs, p)})
        top = hs[int(np.argmax(ll))]
        ood = bool(self.use_ood and top in self.ood_thr and ll.max() < self.ood_thr[top])
        return Posterior(probs, n, ood)


def calibrate_temperature(model: HypothesisModel, cases: Sequence[tuple], grid=(1, 2, 4, 8, 16, 32, 64, 128, 256)) -> Dict[str, float]:
    """Pick the likelihood temperature that minimises negative log-likelihood of the TRUE class on a VALIDATION set
    (cases = [(list_of_z_vectors, true_hypothesis)]). Validation must be disjoint from both training and test."""
    best, rows = None, {}
    hs = [h for h in HYPS if h in model.mu]
    lls = [model._mean_loglik(zs, hs) if len(zs) and hs else None for zs, _ in cases]    # the likelihoods do not depend on T: compute them once
    post = lambda zs, ll: model.posterior(zs) if ll is None else model._posterior(ll, hs, len(zs))
    for T in grid:
        model.temp = float(T)
        nll = float(np.mean([-np.log(max(post(zs, ll).probs[h], 1e-9)) for (zs, h), ll in zip(cases, lls)]))
        rows[float(T)] = nll
        if best is None or nll < best[1] - 1e-12:
            best = (float(T), nll)
    model.temp = best[0]
    return {"chosen_temperature": best[0], "validation_nll": best[1], "grid_nll": rows}
