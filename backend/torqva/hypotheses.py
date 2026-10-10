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
        return "confident" if (self.top_p >= p_conf and self.margin >= margin) else "ambiguous"


class HypothesisModel:
    def __init__(self, max_effective_windows: int = 8, temperature: float = 1.0):
        self.mu: Dict[Hypothesis, np.ndarray] = {}
        self.var: Dict[Hypothesis, np.ndarray] = {}
        self.prior: Dict[Hypothesis, float] = {h: 1.0 / len(HYPS) for h in HYPS}
        self.max_eff = max_effective_windows
        self.temp = temperature
        self.version = 0
        self._hist: List[tuple] = []

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
        z = np.clip(z, -30, 30)
        mu, var = self.mu[h], self.var[h]
        return float(-0.5 * np.sum((z - mu) ** 2 / var + np.log(var)))

    def posterior(self, zs: Sequence[np.ndarray], prior: Optional[Dict[Hypothesis, float]] = None) -> Posterior:
        hs = [h for h in HYPS if h in self.mu]
        pr = prior or self.prior
        if not zs or not hs:
            return Posterior({h: 1.0 / len(HYPS) for h in HYPS}, 0)
        ll = np.array([np.mean([self._loglik(h, z) for z in zs]) for h in hs])     # mean per window
        n_eff = min(len(zs), self.max_eff)                                         # cap evidence from correlated windows
        logp = np.log(np.array([max(pr[h], 1e-9) for h in hs])) + n_eff * ll / self.temp
        logp -= logp.max()
        p = np.exp(logp)
        p /= p.sum()
        probs = {h: 0.0 for h in HYPS}
        probs.update({h: float(pi) for h, pi in zip(hs, p)})
        return Posterior(probs, len(zs))
