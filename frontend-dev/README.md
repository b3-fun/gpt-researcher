# frontend-dev

Tools for working on `frontend/` with no model and no network. See README-B3OS.md, "The page".

- `stub.mjs`: serves `frontend/` as the server does and replays a recorded run on the WebSocket.
- `recording/`: two real runs recorded on B3OS (2026-11-11): `session.json` (Summary, the old page) and
  `session-detailed.json` (Detailed, the new page), with the files their `path` messages link to. Test data.
- `scenarios/`: two test reports the stub can swap in (`tablecode`, `sources40`); their domains are `.example`.
