# GPT Researcher on B3OS

This fork of [assafelovic/gpt-researcher](https://github.com/assafelovic/gpt-researcher) (Apache-2.0, at upstream
commit `ddd4db3`) deploys to [B3OS](https://beta.b3os.org) as one service. GPT Researcher's own FastAPI server, with
its web page, REST API and WebSocket stream, runs in a B3OS sandbox. Its model, web search and page reads go through
B3OS with no API key inside the sandbox, and each finished report is screenshotted and posted to Slack by a B3OS
routine.

B3OS's deploy product (`b3os.yaml` version 1, `b3os apply`, the GitHub App) is a draft that ships with release 11-10
and CLI 0.2.0. Nothing had been deployed with it against beta.b3os.org before this fork.

## What runs where

| GPT Researcher needs | Upstream default | On B3OS |
|---|---|---|
| LLM, all three roles | OpenAI (`gpt-5.4-mini`, `gpt-6-sol`, `gpt-5.4`) | `b3os/default` (Qwen3.5 9B, 32,768-token context) at `http://127.0.0.1:7700/v1/infer`, OpenAI wire format |
| Web search | Tavily | The `crw` retriever, which speaks Firecrawl's `POST /v1/search`, against B3OS's Firecrawl compat at `/compat/firecrawl` (vision search) |
| Page reads | `bs` (direct HTTP from the process) | The `firecrawl` scraper (firecrawl-py `scrape()`) against the same compat layer (vision scrape) |
| Context filter | `auto` (Jev with a TypeSafe key, else keyword) | `keyword` (BM25, local): B3OS serves no embedding model |
| Process and disk | The Dockerfile's container | A B3OS sandbox from the `base` template (Ubuntu 24.04, Python 3.12), restored from a build snapshot |
| Publishing | none | `b3os/routines/publish-report.yaml`: `render/screenshot@1` of the report, then `io.b3os/slack/send-message@1` |

The service's egress is an allowlist with nothing on it: everything above reaches the internet only through B3OS,
under the sandbox's grant (`uses` in `b3os.yaml`) and a 5 USD spend cap.

## What changed, and why

Upstream files changed (every line, with its reason):

| File | Lines | Change | Why |
|---|---|---|---|
| `frontend/index.html`, `frontend/styles.css`, `frontend/scripts.js` | all | rewritten: the B3OS Researcher page (see [The page](#the-page)) | the owner asked for the page to look and work like a B3OS product. The server protocol is unchanged; every path stays relative, because B3OS serves the page under `/sbx/<host>/<port>/<token>/`, where an absolute path drops that prefix and 404s |
| `backend/server/server_utils.py` | 28 | import `public_base`, `publish_report` | the publish hook |
| `backend/server/server_utils.py` | 188 | after the WebSocket path sends the report's file paths, `await publish_report(...)` with the report, its `.md` path and the URL the page was opened at | start the publish routine after each report from the page |
| `backend/server/app.py` | 38 | import `public_base`, `publish_report` | the publish hook |
| `backend/server/app.py` | 336, 354 | `write_report` takes `base_url` and calls `publish_report` after the DOCX and PDF are written | the same for `POST /report/` |
| `backend/server/app.py` | 376, 378, 381, 385 | `generate_report` takes the `Request`, reads its base URL and passes it on | the report link needs the preview URL, which only the request's `X-Forwarded-*` headers carry |
| `gpt_researcher/skills/context_manager.py` | 147-149 | with `CONTEXT_FILTER` `keyword` or `none`, rank written sections by keywords instead of embeddings | the detailed report called an embedding model here whatever `CONTEXT_FILTER` said; B3OS answers `404 model_not_available` for embeddings, which failed the report |
| `gpt_researcher/utils/url_security.py` | 20-24, 54-63, 118 | `ALLOW_UNRESOLVED_URLS=true` lets a host that does not resolve past the SSRF check; IP literals and hosts that resolve to private addresses stay blocked | the sandbox has no DNS for the internet (vision fetches the pages), so every URL was skipped as "Could not resolve host" and the first report on B3OS had no sources |
| `backend/server/app.py` | 124-131 | behind the preview (`X-Forwarded-Prefix` set), a response without `Cache-Control` gets `private, no-cache` | on 2026-11-10 a static file the preview had served once answered every later request with `503 node_unavailable` (a shared cache in front of the node); private responses are not cached there. Browsers still cache and revalidate |
| `gpt_researcher/scraper/firecrawl/firecrawl.py` | 3, 23-41, 50 | when `FIRECRAWL_SERVER_URL` has a path, endpoints are appended to the whole base | firecrawl-py 4.x builds `urljoin(api_url + "/", "/v2/scrape")`, which drops `/compat/firecrawl`: every scrape went to `127.0.0.1:7700/v2/scrape` and answered 404 |
| `gpt_researcher/scraper/firecrawl/firecrawl.py` | 92-94 | `scrape(url)` without `formats=["markdown"]` (Markdown is the default) | with any option firecrawl-py 4.55.0 adds its defaults, `fastMode: false` among them, and B3OS's compat layer answers `400 unrecognized_keys: fastMode` |
| `gpt_researcher/skills/deep_research.py` | 4, 17-19 | `MAX_CONTEXT_WORDS` reads `DEEP_RESEARCH_MAX_CONTEXT_WORDS` (default 25000, upstream's) | 25,000 words of web text is about 33k tokens; with 4,096 output tokens the final Deep Research write asked `b3os/default` (32,768 tokens) for more than its window and failed with `400 context_length_exceeded` (`Error: Failed to get response from openai API` on the page). `b3os.yaml` sets 15000 |
| `.env.example` | renamed `env.example` | content unchanged | B3OS refuses to deploy a service root that tracks a file whose name starts with `.env`, and the GitHub App path has no `--allow-secret-files`. Copy `env.example` to `.env` for a local run, as upstream's README says for `.env.example` |

Checked and left alone: the download links the report message carries (`outputs/<name>.pdf`, `.docx`, `.md`,
`.json`) are already relative, so they resolve under the prefix.

New files:

| File | What it is |
|---|---|
| `b3os.yaml` | The deploy manifest (version 1) |
| `b3os/routines/publish-report.yaml` | The publish routine |
| `b3os/env.b3os` | The integration map as a commented dotenv file, no secrets (same values as `b3os.yaml`'s `env`) |
| `b3os/requirements-b3os.txt` | `firecrawl-py`, which the firecrawl scraper needs and `requirements.txt` leaves out (it would otherwise pip-install it at run time, which egress refuses) |
| `backend/server/b3os_publish.py` | The publish hook, 55 lines |
| `README-B3OS.md` | This file |

Why some files moved: `b3os/env.b3os` is not named `.env.b3os`, and `.env.example` became `env.example`, for the
`.env*` rule above.

## The page

`frontend/` is the page the server serves at `/` (`index.html`) and under `/site/` (everything in `frontend/`) and
`/static/` (`frontend/static/`). Three files make it, with no framework, no CDN and no build step:

| File | What it holds |
|---|---|
| `frontend/index.html` | The markup of every state: ask, running, report, the history drawer; the inline SVG icons, the B3OS wordmark and mark |
| `frontend/styles.css` | The tokens (light, and dark under `prefers-color-scheme`), the dot grid, every component, the print styles (Download, PDF prints the report only) |
| `frontend/scripts.js` | The WebSocket client and everything that draws: the steps, the report, downloads, follow-ups, history |
| `frontend/static/fonts/` | Geist and Geist Mono, latin, variable (SIL Open Font License 1.1, `OFL.txt` beside them) |
| `frontend/static/brand/` | The B3OS wordmark, mark and favicon, as in b3os-beta |
| `frontend/vendor/js/` | Showdown and DOMPurify (upstream's copies), loaded when a report is first drawn, not on the first screen |

Where the look comes from: b3os-beta `apps/web/src/styles/tokens.css` (colours, radii, light and dark),
`recipes.css` and `app.css` (buttons, the segmented control, inputs, the deploy timeline, rendered Markdown), and
`apps/web/public/brand/`. Take values from there; `styles.css` copies them under short names (`--ink`, `--line`,
`--accent`...) at the top of the file. The design and its rules are in the orchestrator's `gptr-ui/DESIGN.md`.

What the page relies on from the server, unchanged from upstream: `start {json}`, `chat {json}` (it sends
`message`, `report` and `messages`, so answers are about the report) and `ping` on the WebSocket at `<page>ws`; the
`logs`, `report`, `path`, `chat` and `error` messages; the `outputs/` links of the `path` message. The four steps
are mapped from the `logs` messages' `content` in `STEP_OF` at the top of `scripts.js`; a `content` that is not
there goes to the log only. Stop closes the socket, and the server cancels a research whose socket closes
(`handle_websocket_communication`). History is upstream's cookie `conversationHistory` (path `/`), with the report
length and its numbers added; a row reopens its report from `outputs/`, which a redeploy empties. The server sends
no PDF link on B3OS (no Pango and Cairo), so Download, PDF prints; Download, JSON is built in the page and holds the
report, its sources and the server's event log.

### Working on it without a model or a network

`frontend-dev/stub.mjs` (Node 18+, no dependencies) serves `frontend/` the way `backend/server/app.py` does, under a
preview-like prefix, and answers the WebSocket by replaying a recorded run from `frontend-dev/recording/`
(`session.json`: a Summary; `session-detailed.json`: a Detailed; both recorded on B3OS from real runs, test data):

```bash
node frontend-dev/stub.mjs --port 8765          # then open http://127.0.0.1:8765/preview/app/8000/
curl '127.0.0.1:8765/__stub/config?speed=10'     # 10x; 1 is real time
curl '127.0.0.1:8765/__stub/config?hold=40'      # stop before frame 40 (hold=report, hold=path); /__stub/release goes on
curl '127.0.0.1:8765/__stub/config?drop=30&dropMode=forever'   # cut the connection (recover is the default)
curl '127.0.0.1:8765/__stub/config?error=50'     # the server's error message mid-run
curl '127.0.0.1:8765/__stub/config?session=detailed'           # or scenario=tablecode, scenario=sources40
curl '127.0.0.1:8765/__stub/frames'              # the frames, to pick a hold
```

Look at a change at 1440 and 390 px, light and dark, before it ships: nothing may scroll sideways at 390 (tables and
code wrap), touch targets are 44 px and form fields 16 px there.

### Shipping a change

Commit, push to the branch B3OS deploys (`git push https://github.com/b3-fun/gpt-researcher.git <branch>:b3os`), and
`b3os apply --yes` from a checkout of that commit ([Deploy it](#deploy-it)). The build snapshot is reused (only
`frontend/` changed), so a page change is live in about 15 s, at a new preview URL.

## The publish hook

The publish is off by default. `b3os.yaml` deploys without the routine, the Slack pack and its connection, and sets
`B3OS_PUBLISH=off`. `b3os.slack.yaml` is the same file with all three and `B3OS_PUBLISH=on`; once the Slack connection
is stored and `SLACK_CHANNEL` is set in it, `b3os apply -f b3os.slack.yaml` deploys the service with the publish.

`backend/server/b3os_publish.py` runs only when `B3OS_PUBLISH` is `1`, `true` or `on`, and `B3OS_API_URL` (set by
B3OS in every sandbox) and `B3OS_PUBLISH_ROUTINE` are both set. After each report it sends
`POST $B3OS_API_URL/v1/routines/publish-report/runs` with the report rendered to HTML (mistune, raw HTML escaped),
the task, the report's id and its link, and `Idempotency-Key: gptr-publish-<id>`. The link is built from the
`X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-Prefix` headers the preview adds, so it is the URL the user
opened, token included. A failure is logged and never fails the report.

The routine screenshots the HTML (`render/screenshot@1` with `html`, 1440x900), not the page on the preview URL:
render draws inline HTML with no network access, so the screenshot does not depend on render reaching
`usercontent.b3os.org`. It then posts the task, the link and the screenshot to Slack with
`io.b3os/slack/send-message@1` (Block Kit image block). Its grant comes from the service's `uses`: `render`,
`routine/publish-report` and `pack/io.b3os/slack`.

## Deploy it

Before either path:

- A B3OS project key with `routines:read`, `routines:write`, `routines:run`, `sandboxes:read`, `sandboxes:write`,
  `sandboxes:run`, `vault:read`, `vault:run`, `actions:read`, `actions:run`, `infer:read`, `infer:run`,
  `vision:run` and `render:run`, a spend cap and an expiry.
- For the Slack publish only (`b3os.slack.yaml`): a Slack connection in the same project, labelled `slack-bot` (`b3os connect io.b3os/slack --label slack-bot`), and
  the bot invited to the channel. Put the channel id in `SLACK_CHANNEL` (now `C0000000000`, a
  placeholder) in `b3os.slack.yaml` or in the routine's `channel` default.

### With the GitHub App

1. Push this fork to a GitHub repository (public if you can).
2. In the console, Applications, connect the repository through the B3OS GitHub App, choose the branch, and link it
   as the application `gpt-researcher` (the file's `name`; a different name fails with `app_mismatch`).
3. Each push to the linked branch plans, builds and deploys; the console shows the plan and the timeline. While a
   deploy is live the App runs a keepalive every 10 minutes, so no workflow is needed.

The App is not registered on beta.b3os.org yet; until it is, use the CLI.

### With `b3os apply` and a project key

From a clone, with the key in `B3OS_API_KEY`. CLI 0.2.0 is not published yet, so run the CLI from a b3os-beta
checkout (`node --conditions=b3os-source packages/cli/src/main.ts` in place of `b3os`):

```bash
b3os manifest validate                 # offline: the file, its schema, the routine file
b3os apply --dry-run                   # reads the project, compiles the routine; changes nothing
b3os apply --yes                       # publish the routine, build, start the service
b3os app status                        # what the application runs, with the preview URL
b3os apply --keepalive --yes           # every 10 minutes, or the service ends within its 3,600 s timeout
b3os app down --app gpt-researcher --yes
```

`apply` deploys the committed tree only (`git archive` of tracked files). For a schedule, copy
`examples/b3os-yaml/github-actions/b3os.yml` from b3os-beta into `.github/workflows/` with the key as the
repository secret `B3OS_API_KEY`.

The first build runs `pip install` of `requirements.txt`, `multi_agents/requirements.txt` and
`b3os/requirements-b3os.txt` into `.venv` and fetches tiktoken's `o200k_base` file into `.tiktoken` (both in
`/workspace/app`), then snapshots the sandbox. Later deploys restore that snapshot until a lockfile, the install
command or the build's `env` changes.

## Environment

Every value is in `b3os.yaml` (`services[0].env`) and, with comments, in `b3os/env.b3os`. In short: model
`openai:b3os/default` for `FAST_LLM`, `SMART_LLM` and `STRATEGIC_LLM` at `OPENAI_BASE_URL=http://127.0.0.1:7700/v1/infer`;
search `RETRIEVER=crw` at `CRW_API_URL=http://127.0.0.1:7700/compat/firecrawl`; scrape `SCRAPER=firecrawl` at
`FIRECRAWL_SERVER_URL` (same URL); token limits `FAST_TOKEN_LIMIT=2000`, `SMART_TOKEN_LIMIT=4096`,
`STRATEGIC_TOKEN_LIMIT=2000`, `BROWSE_CHUNK_MAX_LENGTH=4000`, `TOTAL_WORDS=900`; `CONTEXT_FILTER=keyword`; scraper
workers `MAX_SCRAPER_WORKERS=4`, `FIRECRAWL_CONCURRENCY=4`, `DEEP_RESEARCH_CONCURRENCY=2`; Deep Research's final context `DEEP_RESEARCH_MAX_CONTEXT_WORDS=15000`; `PYTHONUNBUFFERED=1` so `print()` lines reach `b3os app logs` when printed (block-buffered without a terminal, they waited for the next log record); keys are the placeholder
`in-sandbox` (not checked inside a sandbox). No secret is needed. An optional frontier planner (`STRATEGIC_LLM` on
Anthropic) needs a vault connection as a secret and `api.anthropic.com` in egress; see the comments in `b3os.yaml`.

## Known not to work

- **PDF export.** WeasyPrint (through md2pdf) needs Pango and Cairo, which the `base` template does not have and
  `b3os.yaml` cannot install (no apt step, no Dockerfile). The server sends no PDF link; the page's Download, PDF
  prints the report instead (the browser's Save as PDF). The multi-agent report's PDF step fails the same way.
- **Synchronous `POST /report/` over 65 seconds.** With `generate_in_background: false` the request answers only
  when the research ends, and the preview drops any response that has not started within 65 s. Use the page (its
  WebSocket may stay open for an hour), or `generate_in_background: true` (the default). Upstream's background
  path does not save the report in the report store, so `GET /api/reports/{id}` answers 404 for it; the result is
  the Word file at `outputs/<research_id>.docx` (also `GET /report/<research_id>`).
- **Reports lost at redeploy.** `outputs/` and `data/reports.json` live on the sandbox's disk. Each deploy, rollback
  and recreate is a new sandbox, so earlier reports, their download links and the page's server-side history are
  gone (the page's own history in the browser keeps links that then 404). The URL changes too: each generation has
  its own preview URL. Slack keeps the screenshot.
- **Browser scrapers, PDFs and arXiv.** `SCRAPER=browser` and `nodriver` need a local Chromium; PDF links go to
  pymupdf and arXiv links to the arxiv package, both of which fetch directly and are refused by egress. Those
  sources are skipped. The firecrawl scraper's image pass fetches each page directly too and is skipped quietly.
- **Generated images** (`IMAGE_GENERATION_ENABLED`, off by default) need a Google key and write absolute
  `/outputs/images/...` links that miss the prefix.
- **Embeddings mode** (`CONTEXT_FILTER=embeddings`) and Jev (`TYPESAFE_API_KEY`): no embedding model on the node;
  Jev would need its host in egress.
