# Friday debugging

Set `LINUX_BUDDY_DEBUG=1` before starting Friday (or in the checkout's `.env`).
Debugging is off by default. Each launch creates a timestamped JSONL file under
`~/.config/linux-buddy/debug/` (Electron's user-data directory, under
`$XDG_CONFIG_HOME` when set), plus readable `[FRIDAY]` lines on stdout. Files are
created with owner-only permissions.

Watch readable events (follows the newest file across app restarts):

```bash
python3 scripts/debug-logs.py
```

Electron can route console output away from the service journal, so the file reader
is the reliable source for structured events. For service/Chromium diagnostics:

```bash
journalctl --user -u friday-main.service -f -o cat
```

Coverage: app/session startup and exit, renderer/native-process failures, voice state,
local wake detections, transcription lengths, Jev decisions and fallback, IPC requests
with timing/errors (high-frequency audio channels are omitted), task status and
approval state, approval answers, agent tool routes with task/session IDs, Node fetch
requests and Chromium HTTP/WebSocket handshakes (Vite dev-server module loads are
skipped). Request IDs link starts and completions. Node timing ends at response
headers; tool timing ends at the response. Repeated task updates are summarized.

Privacy: no API keys, authorization headers, URL credentials/query/path, request
or response bodies, raw audio, prompts, transcripts or screenshots are logged.
Error names and network codes are recorded rather than potentially sensitive messages.
Task IDs and session IDs let you correlate with saved Friday history when needed.

Limitations: this is not a packet capture. Native LiveKit/WebRTC traffic and agent
subprocess network requests bypass Node/Chromium instrumentation; WebSocket frames,
audio frames and all internal renderer events are not recorded. Termination signals
are not intercepted (that would change shutdown behaviour); a graceful stop shows as
`quit requested` and `process exit`, and SIGKILL cannot be logged by the app. For
termination details, also inspect the service journal. Logs are local and are not
uploaded; delete old debug files when no longer needed.
