#!/usr/bin/env python3
"""Offline evaluation harness for the assessment pipeline.

Runs the real pipeline over annotated fixture photos, repeatedly, and scores
each result against hand-written expectations. Repetition is the point: a
single run cannot distinguish a genuine improvement from ordinary model
variance, which is exactly the mistake this harness exists to prevent.

Usage:
  python tools/eval_assessments.py --runs 3 --variant loop-on
  python tools/eval_assessments.py --runs 3 --variant loop-off --no-retry
  python tools/eval_assessments.py --compare loop-off loop-on

Results append to tools/eval_results.jsonl so variants can be compared later.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

RESULTS = ROOT / "tools" / "eval_results.jsonl"
FIXTURES = ROOT / "tools" / "eval_fixtures.json"

STRUCTURAL_TERMS = (
    "frame", "rail", "pillar", "unibody", "chassis", "radiator support",
    "subframe", "apron", "firewall", "structural", "crossmember",
)


def score_run(case: dict, assessment) -> dict:
    """Score one assessment against the fixture's expectations.

    Each check is pass/fail so the aggregate is a plain accuracy figure rather
    than a weighted score nobody can reason about.
    """
    exp = case["expect"]
    d = assessment.model_dump()
    regions = d.get("regions", [])
    panels = " ".join(f"{r['panel']} {r['damage_type']}" for r in regions).lower()
    checks: dict[str, bool] = {}

    if exp.get("total_loss") is not None:
        checks["total_loss"] = bool(d.get("total_loss")) == bool(exp["total_loss"])

    checks["min_regions"] = len(regions) >= exp.get("min_regions", 1)

    # Upper bounds catch the opposite failure to min_regions: damage
    # invented on a vehicle that does not have it. Without these a
    # negative control cannot fail.
    if exp.get("max_regions") is not None:
        checks["max_regions"] = len(regions) <= exp["max_regions"]

    if exp.get("max_cost") is not None:
        checks["max_cost"] = d.get("estimated_total_cost_usd", 0) <= exp["max_cost"]

    if exp.get("severity_in"):
        checks["severity"] = d.get("overall_severity") in exp["severity_in"]

    if exp.get("panels_any"):
        checks["panels_found"] = any(p in panels for p in exp["panels_any"])

    # Only assert on structure where the photo clearly shows it.
    if exp.get("structural_expected"):
        checks["structural_priced_or_flagged"] = (
            any(t in panels for t in STRUCTURAL_TERMS)
            or any(f["code"] == "possible_underscoped_structural"
                   for f in d.get("assessment_flags", []))
        )

    ev = d.get("evaluation") or {}
    meta = d.get("meta") or {}
    # A run where the vision model or the judge silently fell back is not a
    # measurement of this variant -- it is a measurement of the rate limiter.
    degraded = bool(meta.get("fallback_used")) or bool(ev.get("fallback_used", True))

    # The detector falling back to the classical path means no AI assessment
    # happened at all. That has to register as a failed check: a previous run
    # recorded detector_fallback=True with the judge scoring 14/100 and still
    # reported 5/5 passed, so the aggregate could not see a total outage.
    # Judge fallback is deliberately NOT included here -- it is tracked
    # separately in judge_fallback, and folding it in would fail every run
    # whenever the evaluator is switched off.
    checks["detector_live"] = not bool(meta.get("fallback_used"))
    return {
        "checks": checks,
        "degraded": degraded,
        "provider": meta.get("segmentation_provider", ""),
        "detector_fallback": bool(meta.get("fallback_used")),
        "passed": sum(checks.values()),
        "total": len(checks),
        "regions": len(regions),
        "cost": d.get("estimated_total_cost_usd", 0),
        "value": d.get("estimated_vehicle_value_usd", 0),
        "total_loss": bool(d.get("total_loss")),
        "judge_score": ev.get("overall_score", 0),
        "judge_verdict": ev.get("verdict", ""),
        "judge_fallback": ev.get("fallback_used", True),
        "flags": sorted(f["code"] for f in d.get("assessment_flags", [])),
        "retries": [
            {"trigger": r["trigger_flag"], "stage": r["stage"], "resolved": r["resolved"]}
            for r in d.get("retry_attempts", [])
        ],
    }


def run_variants(variants: list[tuple[str, dict]], runs: int, sleep: float) -> list[dict]:
    """Run variants interleaved, case by case.

    Running all of A then all of B let a per-minute rate limit fall entirely on
    whichever went second: the first attempt showed loop-off at 100% and
    loop-on at 70%, but the loop-on deficit was the model refusing calls, not
    the loop reasoning worse. Interleaving spreads any throttling across both.
    """
    from app.models.schemas import ClaimContext

    cases = json.loads(FIXTURES.read_text())["cases"]
    rows = []
    for case in cases:
        img = ROOT / case["image"]
        if not img.exists():
            print(f"  SKIP {case['id']}: {img} missing")
            continue
        for i in range(runs):
            for variant, env in variants:
                pipeline = _pipeline_for(env)
                t0 = time.time()
                try:
                    assessment = pipeline.run([img.name], [img], ClaimContext(**case["claim"]))
                    scored = score_run(case, assessment)
                    scored["error"] = None
                except Exception as exc:
                    scored = {"checks": {}, "passed": 0, "total": 0,
                              "degraded": True, "error": str(exc)[:160]}
                scored.update(case_id=case["id"], variant=variant, run=i,
                              seconds=round(time.time() - t0, 2))
                rows.append(scored)
                flag = "DEGRADED" if scored.get("degraded") else "ok      "
                print(f"    {flag} {variant:9} {case['id']:16} run{i}  "
                      f"{scored['passed']}/{scored['total']}  "
                      f"judge={scored.get('judge_score')}  {scored['seconds']}s")
                if sleep:
                    time.sleep(sleep)
    return rows


def _pipeline_for(env: dict):
    """Build a pipeline with the variant's config applied."""
    import importlib
    for k, v in env.items():
        os.environ[k] = v
    import app.core.config as config
    importlib.reload(config)
    for mod in ("app.services.evaluation", "app.services.assessment_pipeline"):
        importlib.reload(importlib.import_module(mod))

    from app.services.assessment_pipeline import AssessmentPipeline
    from app.services.evaluation import AssessmentEvaluator
    from app.services.report_generation import ClaimReportService
    from app.services.segmentation import get_segmentation_service

    seg = get_segmentation_service()
    return AssessmentPipeline(seg, ClaimReportService(),
                              AssessmentEvaluator(getattr(seg, "narrator", None)))


def _unused_run_variant(variant: str, runs: int) -> list[dict]:
    # Imported here so env overrides land before config is read.
    from app.models.schemas import ClaimContext
    from app.services.assessment_pipeline import AssessmentPipeline
    from app.services.evaluation import AssessmentEvaluator
    from app.services.report_generation import ClaimReportService
    from app.services.segmentation import get_segmentation_service

    seg = get_segmentation_service()
    narrator = getattr(seg, "narrator", None)
    pipeline = AssessmentPipeline(seg, ClaimReportService(), AssessmentEvaluator(narrator))

    print(f"  provider: {seg.provider_name}   variant: {variant}   runs/case: {runs}")
    if narrator is None:
        print("  WARNING: no model provider — results will not reflect real behaviour")

    cases = json.loads(FIXTURES.read_text())["cases"]
    rows = []
    for case in cases:
        img = ROOT / case["image"]
        if not img.exists():
            print(f"  SKIP {case['id']}: {img} missing")
            continue
        for i in range(runs):
            t0 = time.time()
            try:
                assessment = pipeline.run(
                    [img.name], [img], ClaimContext(**case["claim"])
                )
                scored = score_run(case, assessment)
                scored["error"] = None
            except Exception as exc:  # a crash is a failed run, not a crashed harness
                scored = {"checks": {}, "passed": 0, "total": 0, "error": str(exc)[:160]}
            scored.update(
                case_id=case["id"], variant=variant, run=i,
                seconds=round(time.time() - t0, 2),
            )
            rows.append(scored)
            mark = "ok " if scored.get("error") is None else "ERR"
            print(f"    {mark} {case['id']:18} run{i}  "
                  f"{scored['passed']}/{scored['total']} checks  "
                  f"judge={scored.get('judge_score')}  {scored['seconds']}s")
    return rows


def summarise(rows: list[dict], variant: str) -> None:
    usable = [r for r in rows if r.get("error") is None and not r.get("degraded")]
    degraded = [r for r in rows if r.get("degraded")]
    if degraded:
        print(f"\n  EXCLUDED {len(degraded)} degraded run(s) (model fell back; measures the rate limiter, not the variant)")
    ok = usable
    if not ok:
        print("  no successful runs")
        return
    by_case: dict[str, list[dict]] = {}
    for r in ok:
        by_case.setdefault(r["case_id"], []).append(r)

    print(f"\n  === {variant} ===")
    for cid, rs in sorted(by_case.items()):
        acc = [r["passed"] / r["total"] for r in rs if r["total"]]
        costs = [r["cost"] for r in rs]
        judges = [r["judge_score"] for r in rs]
        spread = (max(costs) - min(costs)) if costs else 0
        print(f"  {cid:18} accuracy {statistics.mean(acc):.0%}"
              f"  judge {statistics.mean(judges):.0f}"
              f"  cost ${statistics.mean(costs):,.0f} (spread ${spread:,})"
              f"  TL {sum(r['total_loss'] for r in rs)}/{len(rs)}")
        failed: dict[str, int] = {}
        for r in rs:
            for k, v in r["checks"].items():
                if not v:
                    failed[k] = failed.get(k, 0) + 1
        if failed:
            print(f"  {'':18} failing: {failed}")

    all_acc = [r["passed"] / r["total"] for r in ok if r["total"]]
    print(f"\n  OVERALL accuracy: {statistics.mean(all_acc):.1%} over {len(ok)} runs")
    retried = [r for r in ok if r.get("retries")]
    print(f"  runs that retried: {len(retried)}/{len(ok)}")
    resolved = sum(1 for r in retried for a in r["retries"] if a["resolved"])
    print(f"  retries that resolved their trigger: {resolved}")


def compare(a: str, b: str) -> None:
    if not RESULTS.exists():
        print("no results yet"); return
    rows = [json.loads(l) for l in RESULTS.read_text().splitlines() if l.strip()]

    def acc(v):
        rs = [r for r in rows if r["variant"] == v and r.get("error") is None
              and r.get("total") and not r.get("degraded")]
        return [r["passed"] / r["total"] for r in rs], rs

    acc_a, rows_a = acc(a)
    acc_b, rows_b = acc(b)
    if not acc_a or not acc_b:
        print(f"need results for both '{a}' and '{b}'"); return

    ma, mb = statistics.mean(acc_a), statistics.mean(acc_b)
    sa = statistics.stdev(acc_a) if len(acc_a) > 1 else 0.0
    sb = statistics.stdev(acc_b) if len(acc_b) > 1 else 0.0
    print(f"  {a:12} accuracy {ma:.1%}  sd {sa:.1%}  n={len(acc_a)}")
    print(f"  {b:12} accuracy {mb:.1%}  sd {sb:.1%}  n={len(acc_b)}")
    delta = mb - ma
    noise = max(sa, sb)
    print(f"\n  delta: {delta:+.1%}")
    if abs(delta) <= noise:
        print(f"  VERDICT: within run-to-run noise (sd {noise:.1%}) — not a demonstrated improvement")
    else:
        print(f"  VERDICT: delta exceeds observed spread (sd {noise:.1%}) — but n is small; treat as suggestive")

    for label, rs in ((a, rows_a), (b, rows_b)):
        r = sum(1 for x in rs if x.get("retries"))
        print(f"  {label:12} retried on {r}/{len(rs)} runs")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=2)
    ap.add_argument("--variant", default="default")
    ap.add_argument("--no-retry", action="store_true", help="disable the self-correction loop")
    ap.add_argument("--no-evaluator", action="store_true", help="disable the LLM judge")
    ap.add_argument("--compare", nargs=2, metavar=("A", "B"))
    ap.add_argument("--ab", action="store_true",
                    help="run loop-off and loop-on interleaved in one pass")
    ap.add_argument("--sleep", type=float, default=4.0,
                    help="pause between runs to stay under per-minute rate limits")
    args = ap.parse_args()

    if args.compare:
        compare(*args.compare)
        return 0

    variants = [
        ("loop-off", {"ENABLE_ASSESSMENT_RETRY": "false"}),
        ("loop-on", {"ENABLE_ASSESSMENT_RETRY": "true"}),
    ] if args.ab else [(args.variant, {
        "ENABLE_ASSESSMENT_RETRY": "false" if args.no_retry else "true",
        "ENABLE_ASSESSMENT_EVALUATOR": "false" if args.no_evaluator else "true",
    })]

    rows = run_variants(variants, args.runs, args.sleep)
    for name, _ in variants:
        summarise([r for r in rows if r["variant"] == name], name)

    with RESULTS.open("a") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")
    print(f"\n  appended {len(rows)} rows -> {RESULTS.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
