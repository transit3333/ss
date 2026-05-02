# metro36

Metro map editor and routing UI, with a separate CTA train live-data pipeline.

## Live Data Pipeline

The collector entrypoint is `python -m pipeline.collector`.

The runtime pipeline uses only the Python standard library.

Run one live collection cycle and export a JSON snapshot:

```bash
python -m pipeline.collector --once --export-json
```

Run continuous live collection:

```bash
python -m pipeline.collector --collect --export-json
```

Show pipeline status:

```bash
python -m pipeline.collector --status
```

Default snapshot output:

```text
data/live/cta_train_snapshot.json
```

## Non-Deterministic SSP Planner

The stochastic planner entrypoint is `python -m pipeline.ssp_solver`.

Example:

```bash
python -m pipeline.ssp_solver --from-station "Clark/Lake" --to-station "Midway" --episodes 300 --horizon 10
```

Default planner output:

```text
data/live/ssp_plan.json
```

Benchmark the live stochastic planner against plain BFS over `1/2/4/6/8` hour history windows:

```bash
python -m pipeline.benchmark --from-station "Clark/Lake" --to-station "Midway"
```

Default benchmark output:

```text
data/live/benchmark_results.json
```

The planner uses:

- `chicago.json` for topology
- collected CTA live arrivals as the stochastic cost signal
- an `LCB-ADVANTAGE-SSP` style lower-confidence planner for the live SSP backend

The CTA API key is loaded from `.env`, and `.gitignore` excludes secrets, SQLite files, logs, and generated live data.
