import asyncio
import os
from urllib.parse import urlparse

from bs4 import BeautifulSoup

from ..utils import get_relevant_images

# Module-level semaphore shared across all FireCrawl instances.
# Limits concurrent API calls to avoid exceeding FireCrawl rate limits.
# FireCrawl Free Tier allows 2 concurrent browsers; configurable via FIRECRAWL_CONCURRENCY.
_semaphore: asyncio.Semaphore | None = None


def _get_semaphore() -> asyncio.Semaphore:
    global _semaphore
    if _semaphore is None:
        max_concurrent = int(os.environ.get("FIRECRAWL_CONCURRENCY", "2"))
        _semaphore = asyncio.Semaphore(max_concurrent)
    return _semaphore


def _keep_base_path(app, api_url: str) -> None:
    """firecrawl-py 4.x joins "/v2/scrape" onto api_url with urljoin, which drops a base path such as
    /compat/firecrawl (B3OS's Firecrawl compat layer) and sends the request to the host's /v2/scrape.
    When api_url has a path, append the endpoint to the whole base instead."""
    base = api_url.rstrip("/")
    if not urlparse(base).path:
        return
    http = getattr(getattr(app, "_v2_client", None), "http_client", None)
    original = getattr(http, "_build_url", None)
    if original is None:
        return

    def build(endpoint: str) -> str:
        if endpoint.startswith("/") and not urlparse(endpoint).netloc:
            return base + endpoint
        return original(endpoint)

    http._build_url = build


class FireCrawl:

    def __init__(self, link, session=None):
        self.link = link
        self.session = session
        from firecrawl import FirecrawlApp
        self.firecrawl = FirecrawlApp(api_key=self.get_api_key(), api_url=self.get_server_url())
        _keep_base_path(self.firecrawl, self.get_server_url())

    def get_api_key(self) -> str:
        """
        Gets the FireCrawl API key
        Returns:
        Api key (str)
        """
        try:
            api_key = os.environ["FIRECRAWL_API_KEY"]
        except KeyError:
            raise Exception(
                "FireCrawl API key not found. Please set the FIRECRAWL_API_KEY environment variable.")
        return api_key

    def get_server_url(self) -> str:
        """
        Gets the FireCrawl server URL.
        Default to official FireCrawl server ('https://api.firecrawl.dev').
        Returns:
        server url (str)
        """
        try:
            server_url = os.environ["FIRECRAWL_SERVER_URL"]
        except KeyError:
            server_url = 'https://api.firecrawl.dev'
        return server_url

    def scrape(self) -> tuple:
        """
        This function extracts content and title from a specified link using the FireCrawl Python SDK,
        images from the link are extracted using the functions from `gpt_researcher/scraper/utils.py`.

        Returns:
          The `scrape` method returns a tuple containing the extracted content, a list of image URLs, and
        the title of the webpage specified by the `self.link` attribute. It uses the FireCrawl Python SDK to
        extract and clean content from the webpage. If any exception occurs during the process, an error
        message is printed and an empty result is returned.
        """

        try:
            # Fixed: Changed from scrape_url() to scrape() to match FireCrawl SDK v4.6.0+
            # No options: Markdown is the default format. Any option makes firecrawl-py 4.x add its defaults,
            # fastMode among them, which B3OS's Firecrawl compat layer refuses (400 unrecognized_keys).
            response = self.firecrawl.scrape(url=self.link)

            # Check if the page has been scraped successfully
            # Fixed: Access metadata attributes directly (not as dict keys)
            if response.metadata and response.metadata.error:
                print("Scrape failed! : " + str(response.metadata.error))
                return "", [], ""
            elif response.metadata and response.metadata.status_code and response.metadata.status_code != 200:
                print(f"Scrape failed! Status code: {response.metadata.status_code}")
                return "", [], ""

            # Extract the content (markdown) and title from FireCrawl response
            # Fixed: Access attributes directly (not as dict keys)
            content = response.markdown if response.markdown else ""
            title = response.metadata.title if response.metadata and response.metadata.title else ""

            # Optional image pass. Session may be None when FireCrawl is used
            # outside Scraper; never attribute-error on session.get.
            image_urls = []
            if self.session is not None:
                try:
                    response_bs = self.session.get(self.link, timeout=4)
                    soup = BeautifulSoup(
                        response_bs.content,
                        "lxml",
                        from_encoding=response_bs.encoding,
                    )
                    image_urls = get_relevant_images(soup, self.link)
                except Exception as img_err:
                    print(f"FireCrawl image extraction skipped: {img_err}")

            return content, image_urls, title

        except Exception as e:
            print("Error! : " + str(e))
            return "", [], ""

    async def scrape_async(self) -> tuple:
        """
        Async version of scrape() with concurrency limiting to avoid FireCrawl API rate limits.

        FireCrawl Free Tier limits concurrent browsers to 2. When deep research mode launches
        many parallel requests, most fail silently with empty content. This method uses a shared
        module-level semaphore so that at most FIRECRAWL_CONCURRENCY requests run simultaneously
        across all FireCrawl instances (default: 2).

        Returns:
            Tuple of (content, image_urls, title) — same as scrape().
        """
        async with _get_semaphore():
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(None, self.scrape)
