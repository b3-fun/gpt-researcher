"""Publish each finished report through a B3OS routine: a screenshot of the report, posted to Slack.

Only inside a B3OS sandbox, where B3OS_API_URL is set and needs no key. B3OS_PUBLISH_ROUTINE names the routine
(b3os/routines/publish-report.yaml); without it nothing is published.
"""

import logging
import os

import httpx
import mistune

logger = logging.getLogger(__name__)

_to_html = mistune.create_markdown(escape=True, plugins=["table", "strikethrough"])
_PAGE = (
    '<!doctype html><html><head><meta charset="utf-8"><style>'
    "body{font:16px/1.55 system-ui,sans-serif;max-width:880px;margin:40px auto;padding:0 32px;color:#1b1b1b}"
    "h1,h2,h3{line-height:1.25}a{color:#0b5cad}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}"
    "</style></head><body>{body}</body></html>"
)


def public_base(headers) -> str:
    """The URL the page was opened at, from the preview's X-Forwarded-* headers, ending in '/'; '' when not proxied."""
    prefix, host = headers.get("x-forwarded-prefix"), headers.get("x-forwarded-host")
    if not prefix or not host:
        return ""
    return f"{headers.get('x-forwarded-proto', 'https')}://{host}{prefix.rstrip('/')}/"


async def publish_report(research_id: str, task: str, report: str, report_path: str = "", base_url: str = "") -> None:
    """Start the publish routine for one report. Never raises: a report is finished whether or not it is published."""
    routine, api = os.getenv("B3OS_PUBLISH_ROUTINE"), os.getenv("B3OS_API_URL")
    if not routine or not api or not report:
        return
    try:
        payload = {
            "research_id": research_id,
            "task": str(task)[:1000],
            "html": _PAGE.replace("{body}", _to_html(str(report))),
            "report_url": f"{base_url}{report_path}" if base_url and report_path else "",
        }
        if os.getenv("SLACK_CHANNEL"):
            payload["channel"] = os.environ["SLACK_CHANNEL"]
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(
                f"{api.rstrip('/')}/v1/routines/{routine}/runs",
                json={"input": payload},
                headers={"Idempotency-Key": f"gptr-publish-{research_id}"},
            )
            r.raise_for_status()
        logger.info(f"Publish routine {routine} started for {research_id}: run {r.json().get('id')}")
    except Exception as e:
        logger.warning(f"Publish routine {routine} not started for {research_id}: {e}")
