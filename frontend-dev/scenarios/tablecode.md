# Reconnecting a Browser WebSocket Without Losing Work

## Summary

A browser WebSocket gives no delivery guarantee across a dropped connection: the server sees a disconnect, and whatever it was doing for that client usually ends with it ([Socket Notes](https://www.socket-notes.example/close-codes)). A page that wants to survive a drop has two jobs: notice the drop quickly, and decide whether the work can be resumed or must start over ([Edge Handbook](https://handbook.edge-proxy.example/websockets/idle)).

## How a drop shows up in the page

The `close` event carries a code. A clean close from the server is `1000`; a cut connection with no close frame arrives as `1006`, which the page can never send itself ([Socket Notes](https://www.socket-notes.example/close-codes)).

| Code | Meaning | Who sends it | What the page should do |
| :--- | :--- | :--- | :--- |
| 1000 | Normal closure | either side | nothing |
| 1001 | Going away | server restarting, tab closing | reconnect after a short wait |
| 1006 | Abnormal closure, no close frame | nobody: the browser reports it | reconnect with backoff |
| 1011 | Internal error | server | show the error, offer a retry |
| 1013 | Try again later | server or proxy | reconnect after `Retry-After` |

Proxies add their own limits: an idle timeout of 60 to 100 seconds is common, so a long silent step needs a heartbeat ([Edge Handbook](https://handbook.edge-proxy.example/websockets/idle); [Proxy FAQ](https://faq.proxy-vendor.example/ws-timeouts)).

## A small reconnect loop

The loop below retries with an exponential backoff and a cap, and gives up after five tries:

```js
function connect(url, { tries = 5, base = 2000, onGiveUp } = {}) {
  let attempt = 0;
  const open = () => {
    const ws = new WebSocket(url);
    ws.onopen = () => { attempt = 0; };
    ws.onclose = (e) => {
      if (e.code === 1000) return;
      if (++attempt > tries) return onGiveUp?.(e);
      setTimeout(open, Math.min(base * 1.5 ** (attempt - 1), 15000));
    };
    return ws;
  };
  return open();
}
```

On the server side, the matching rule is to cancel the task when its socket goes away, so a dead client does not keep spending:

```python
async def handle(websocket):
    task = None
    try:
        async for message in websocket:
            if message.startswith("start"):
                task = asyncio.create_task(run(message[6:], websocket))
    finally:
        if task and not task.done():
            task.cancel()
```

A one-line heartbeat keeps proxies from closing a quiet socket: `setInterval(() => ws.send("ping"), 25_000)`.

## Choosing a strategy

| Strategy | Cost on a drop | Needs on the server | Good for |
| :--- | :--- | :--- | :--- |
| Start over | the whole run | nothing | short runs under a minute |
| Resume from a checkpoint | the current step | a run id and stored steps | long runs |
| Detach and poll | none | a job queue and a status endpoint | very long runs, many clients |

For runs under a minute, starting over is usually the honest choice: it is simple, and the user sees exactly what happened ([Backoff Patterns](https://patterns.retry-lab.example/backoff)).

## Sources

Edge Handbook. (2026). *WebSockets behind a proxy: idle timeouts and heartbeats.* [https://handbook.edge-proxy.example/websockets/idle](https://handbook.edge-proxy.example/websockets/idle)

Proxy FAQ. (2025). *Why do my WebSocket connections close after 100 seconds?* [https://faq.proxy-vendor.example/ws-timeouts](https://faq.proxy-vendor.example/ws-timeouts)

Backoff Patterns. (2024). *Exponential backoff with jitter, explained.* [https://patterns.retry-lab.example/backoff](https://patterns.retry-lab.example/backoff)

Socket Notes. (2026). *Every WebSocket close code, and what to do about it.* [https://www.socket-notes.example/close-codes](https://www.socket-notes.example/close-codes)
