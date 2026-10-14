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

## Microphone segments

With debugging on, the renderer also reports each microphone segment's lifecycle as
`VOICE segment` records. Main validates every record against a fixed event list and keeps
only metadata: a random segment id, renderer monotonic time (`atMs`), request revision,
audio covered (`coverageMs`), decode counts, room level (`floorDb`, absent until calibrated),
the level behind the event (`levelDb`), quiet time after speech (`quietMs`) and, for recovery
events, a fixed `reason`. Never audio or transcript text.

| Event                                      | Meaning                                                                                                                                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `speech-start`                             | Sound crossed the onset threshold; a turn began. `levelDb` is the onset frame; `reason: tail` when it continues a cut-off sentence.                                                                                                                                            |
| `inference-start` / `inference-end`        | One recognition request for `coverageMs` of audio was sent / answered.                                                                                                                                                                                                         |
| `inference-retry`                          | The host cancelled the turn's decode (its state was reset); it is asked once more.                                                                                                                                                                                             |
| `inference-timeout`                        | No answer within the recognition limit (Groq 22 s, Parakeet 125 s); the turn fails recoverably.                                                                                                                                                                                |
| `endpoint`                                 | Enough quiet (`quietMs`) after speech: the turn is complete pending its final decode.                                                                                                                                                                                          |
| `endpoint-revoked`                         | Speech resumed before the final was delivered; the turn continues.                                                                                                                                                                                                             |
| `endpoint-extended`                        | The text ends mid-phrase ("open the"): the final waits up to 1.6 s of quiet.                                                                                                                                                                                                   |
| `final-ready` / `final-delivered`          | The final decode covers the turn / was handed to the app.                                                                                                                                                                                                                      |
| `noise-steady`                             | 2.4 s of steady sound (fan, hum, hiss) held the turn open: the room level was raised to it (`levelDb`) and the turn ends after its last distinct sound.                                                                                                                        |
| `noise-discarded`                          | Since its onset the turn held only steady sound (fan, hum, hiss): discarded without a decode, room recalibrated.                                                                                                                                                               |
| `noise-trimmed`                            | A decode of 3 s or more came back empty: audio before its last 1.5 s is dropped as wordless (and calibrates the room); the rest stays the turn, which still ends only at a real endpoint.                                                                                      |
| `tail-discarded`                           | A turn that began while a cut-off sentence was still guarded reached its endpoint: dropped without decoding (with no local wake detector it is decoded and counts only if it starts with “Hey Friday”). Its endpoint does not end the guard.                                   |
| `turn-boundary`                            | After a cut-off sentence, an unbroken 860 ms in which no 60 ms level is voiced against the room as it was before the cut (the same 1.4x test open turns use; any voiced frame restarts it): whatever follows is a fresh turn. A wake word or tapping Talk also ends the guard. |
| `probe`                                    | Hosted recognition only: one decode of a turn still going at 8 s, to tell wordless sound from a long request.                                                                                                                                                                  |
| `capacity-sealed`                          | The 25 s buffer filled after the endpoint; recording stops and the pending final is still delivered.                                                                                                                                                                           |
| `overrun`                                  | The turn never ended within 25 s (counting audio already trimmed as wordless): discarded, never submitted, listening continues, and what follows is guarded as a possible continuation.                                                                                        |
| `overrun-retry` / `overrun-fallback`       | An engaged conversation asked the user to repeat / fell back to wake-word listening after repeated overruns, or after the first wake-started request overran.                                                                                                                  |
| `recognition-error`                        | A turn failed (`reason`: `timeout`, `error` or `cap`); listening restarts unless the mic is off.                                                                                                                                                                               |
| `capture-stall`                            | No microphone frames for 2.5 s while listening.                                                                                                                                                                                                                                |
| `capture-recovering` / `capture-recovered` | The capture graph failed (worklet overflow, LiveKit drop, stall) and was rebuilt on the same stream.                                                                                                                                                                           |
| `capture-failed`                           | Recovery was impossible or repeated more than 3 times a minute: the mic turned off with an error.                                                                                                                                                                              |

### Manual voice checks

Start Friday with `LINUX_BUDDY_DEBUG=1` and watch `python3 scripts/debug-logs.py`.

1. **Sustained noise.** With Friday listening (after "Hey Friday" or Talk), run a fan or play
   steady white/brown noise near the mic for 30 s without speaking. Expect `speech-start` then
   `noise-discarded` within ~3 s, the mic still on, and no error. Groq should make no decode;
   local recognition may start an interim decode, but its late result must not be submitted.
2. **Speech, then noise.** Say "open my downloads folder", then immediately start the fan.
   Expect `noise-steady` (or a normal `endpoint`), one `final-delivered`, and the full request.
3. **Speech over noise.** With the fan running for a few seconds first, speak a request at a
   normal volume. It must start, endpoint after you stop, and arrive complete.
4. **Long request.** Speak naturally for ~20 s in a quiet room: one turn, one final, nothing cut.
5. **Babble / TV.** Leave talk radio or a video playing next to the mic while engaged. After
   ~25 s expect `overrun`, `overrun-retry` and “Too noisy to hear the end. Please say it again.”
   in the compact status; after a second one, `overrun-fallback` and “Say ‘Hey Friday’ to try
   again”. Nothing is submitted and the mic stays on.
6. **Cut-off sentence.** Talk continuously for ~27 s while engaged. After the notice, keep
   talking briefly, then stop: expect `tail-discarded` and no request. Pause ~1 s, then say a
   short request: it is heard (`turn-boundary`, then a normal final).
7. **Quiet speaker in noise.** With a fan running, speak softly (barely above the fan) for ~10 s
   with short thinking pauses. Expect one `endpoint` after you stop, not several.
8. **Slow network.** Throttle or briefly disconnect the network after speaking. Expect either a
   late `final-delivered`, or `inference-timeout` with “Recognition timed out. Please say it
   again.” in the status line; never “too long” for a short request, and listening continues.
9. **Wake pause.** Say "Hey Friday, open the …", pause ~1 s, then finish the sentence. The state
   stays armed/transcribing (never "Say Hey Friday") and the whole request arrives once.
10. **Mic off / Stop.** Turn the mic off or press Stop mid-turn: nothing is submitted later.
    Mic-off stays off; Stop returns an enabled microphone to wake-word waiting.
11. **First wake request overruns.** Let Friday rest, say “Hey Friday”, then keep speaking without
    an endpoint for ~27 s. Expect `overrun-fallback` and “Too noisy. Say ‘Hey Friday’ to try
    again.”, followed by the usual wake hint, never a stuck “Listening…”. Nothing is submitted;
    another “Hey Friday, what time is it?” works without toggling the mic.

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
