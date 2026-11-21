"""Measure complete responses from a local acceptance stack."""

import argparse
import json
import math
import ssl
import struct
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.request import HTTPRedirectHandler, HTTPSHandler, ProxyHandler, build_opener


class RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(origin, case, opener):
    started = time.perf_counter()
    with opener.open(origin + case["path"], timeout=15) as response:
        if response.status != 200:
            raise ValueError(f'{case["path"]}: HTTP {response.status}, expected 200')
        content_type = response.headers.get_content_type()
        body = response.read()
    elapsed_ms = (time.perf_counter() - started) * 1000
    if "features" in case:
        count = len(json.loads(body)["features"])
        if count != case["features"]:
            raise ValueError(f'{case["path"]}: expected {case["features"]} features, got {count}')
    if "png" in case:
        if content_type != "image/png" or body[:16] != b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR" or len(body) < 24:
            raise ValueError(f'{case["path"]}: invalid PNG header')
        width, height = struct.unpack_from(">II", body, 16)
        if [width, height] != case["png"]:
            raise ValueError(f'{case["path"]}: expected PNG dimensions {case["png"]}, got {width} x {height}')
    return elapsed_ms, len(body)


def docker(*arguments):
    return subprocess.check_output(["docker", *arguments], encoding="utf-8", timeout=40)


def sample_resources(containers, done):
    samples = []
    while True:
        output = docker("stats", "--no-stream", "--format", "{{json .}}", *containers)
        rows = [json.loads(line) for line in output.splitlines()]
        if len(rows) != len(containers):
            raise ValueError("docker stats did not report every running container")
        samples.append(rows)
        if done.wait(1):
            return samples


def measure(origin, cases, workers, seconds, project, opener):
    for case in cases:
        request(origin, case, opener)
    containers = []
    if project:
        containers = docker("ps", "-q", "--filter", f"label=com.docker.compose.project={project}").split()
        if not containers:
            raise ValueError(f"no running containers for {project}")

    barrier = threading.Barrier(workers)
    done = threading.Event()

    def worker():
        barrier.wait()
        deadline = time.perf_counter() + seconds
        results = [[] for _ in cases]
        while True:
            for case, samples in zip(cases, results):
                samples.append(request(origin, case, opener))
            if time.perf_counter() >= deadline:
                return results

    with ThreadPoolExecutor(max_workers=workers + bool(containers)) as pool:
        resource_job = pool.submit(sample_resources, containers, done) if containers else None
        started = time.perf_counter()
        try:
            results = list(pool.map(lambda _: worker(), range(workers)))
        finally:
            done.set()
        elapsed = time.perf_counter() - started
        resources = resource_job.result() if resource_job else []

    summary = []
    for index, case in enumerate(cases):
        durations, sizes = zip(*(sample for worker_results in results for sample in worker_results[index]))
        sorted_ms = sorted(durations)
        summary.append({
            **case,
            "requests": len(durations),
            "p50Ms": round(sorted_ms[math.ceil(len(durations) * 0.50) - 1], 2),
            "p95Ms": round(sorted_ms[math.ceil(len(durations) * 0.95) - 1], 2),
            "maxMs": round(sorted_ms[-1], 2),
            "minBytes": min(sizes),
            "maxBytes": max(sizes),
        })
    report = {
        "python": sys.version.split()[0],
        "workers": workers,
        "elapsedSeconds": round(elapsed, 3),
        "cases": summary,
    }
    if containers:
        published = docker("inspect", "--size", "--format",
                           '[{{json .Name}},{{json .Image}},{{json .Config.Image}},{{json .SizeRw}}]', *containers)
        report["containers"] = [
            dict(zip(("name", "imageId", "image", "writableBytes"), json.loads(line)))
            for line in published.splitlines()
        ]
        report["dockerStats"] = resources
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("origin")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--seconds", type=float, default=8)
    parser.add_argument("--project")
    parser.add_argument("--ca-file")
    args = parser.parse_args()
    if args.workers < 1 or not math.isfinite(args.seconds) or args.seconds <= 0:
        parser.error("workers and seconds must be positive")
    try:
        cases = json.load(sys.stdin)
        if not cases or any(not case["path"].startswith("/") for case in cases):
            raise ValueError("supply at least one absolute request path")
        context = ssl.create_default_context(cafile=args.ca_file)
        opener = build_opener(ProxyHandler({}), HTTPSHandler(context=context), RejectRedirects())
        report = measure(args.origin.rstrip("/"), cases, args.workers, args.seconds, args.project, opener)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(f"Acceptance measurement failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
