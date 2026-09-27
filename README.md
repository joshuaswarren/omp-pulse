# omp-pulse

One line of transcript status in the [omp](https://github.com/can1357/oh-my-pi) TUI, refreshed on a timer while a turn is running.

The strip reads the session branch omp already keeps and asks a cheap model for a single line. It paints that line with `setStatus` and `setWidget`. It does not send a prompt, steer, follow-up, or aside into the live turn.

```
+--------------------------------------------------------------+
|  editor                                                      |
+--------------------------------------------------------------+
| pulse · editing the status strip                             |  widget, belowEditor
| git · model · ctx                                            |  native statusline
| pulse · editing the status strip                             |  setStatus
+--------------------------------------------------------------+
```

`belowEditor` sits above omp's native statusline. A slot under that statusline is still open upstream ([oh-my-pi #11100](https://github.com/can1357/oh-my-pi/issues/11100)). `setFooter` and `setHeader` are no-ops ([oh-my-pi #13473](https://github.com/can1357/oh-my-pi/issues/13473)), so this extension does not call them.

On turn start the line is a local extract of the latest user and assistant text, so the strip is not blank for the whole interval. The cheap model rewrites it on the timer (default 7 minutes) and again when the turn ends, if the transcript changed. `/pulse` refreshes on demand.

The in-flight token stream is not on the branch until omp records the message. The strip summarizes persisted session messages, not a second queue.

## Install

```sh
omp plugin install omp-pulse
```

From a checkout:

```sh
omp plugin link /path/to/omp-pulse
```

Requires Node 20 or newer and omp with managed timers (`ctx.setInterval`, omp 18.1 or newer). On an older omp the extension falls back to a raw timer.

## Config

Optional file at `~/.omp/agent/omp-pulse/config.json`. Environment variables override the file. With neither, the extension calls a local OpenAI-compatible server (Ollama's default) and, if that call fails, keeps the local extract.

```json
{
  "intervalMs": 420000,
  "refreshWhileIdle": false,
  "surface": "both",
  "placement": "belowEditor",
  "maxTranscriptChars": 8000,
  "provider": {
    "baseUrl": "http://127.0.0.1:11434/v1",
    "model": "qwen2.5:0.5b",
    "apiKey": "",
    "timeoutMs": 15000
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `intervalMs` | `420000` (7 min) | Model refresh while a turn is running. Clamped to 1 to 30 minutes. Use 300000 to 600000 for the 5 to 10 minute range. |
| `refreshWhileIdle` | `false` | Also run the model refresh when no turn is active, if the transcript changed. |
| `surface` | `both` | `status` (`setStatus` only), `widget` (`setWidget` only), or `both`. |
| `placement` | `belowEditor` | `aboveEditor` or `belowEditor`. |
| `maxTranscriptChars` | `8000` | Tail of the branch sent to the model. |
| `provider.baseUrl` | `http://127.0.0.1:11434/v1` | OpenAI-compatible base URL. The extension POSTs `{baseUrl}/chat/completions`. |
| `provider.model` | `qwen2.5:0.5b` | Model name on that endpoint. |
| `provider.apiKey` | empty | Sent as `Authorization: Bearer` when set. Ollama does not need one. |
| `provider.timeoutMs` | `15000` | Request timeout. |

Environment overrides:

| Variable | Overrides |
| --- | --- |
| `OMP_PULSE_INTERVAL_MS` | `intervalMs` |
| `OMP_PULSE_IDLE` | `refreshWhileIdle` (`true`/`1` or `false`/`0`) |
| `OMP_PULSE_SURFACE` | `surface` |
| `OMP_PULSE_PLACEMENT` | `placement` |
| `OMP_PULSE_MAX_CHARS` | `maxTranscriptChars` |
| `OMP_PULSE_BASE_URL` | `provider.baseUrl` |
| `OMP_PULSE_MODEL` | `provider.model` |
| `OMP_PULSE_API_KEY` | `provider.apiKey` |
| `OMP_PULSE_TIMEOUT_MS` | `provider.timeoutMs` |

### Local model

```sh
ollama pull qwen2.5:0.5b
```

The default base URL is Ollama's OpenAI-compatible endpoint. Any small model you already serve on `/v1` works if you set `OMP_PULSE_MODEL`.

### Fleet or other OpenAI-compatible endpoint

```sh
export OMP_PULSE_BASE_URL=http://fleet-host:8000/v1
export OMP_PULSE_MODEL=qwen2.5-0.5b
export OMP_PULSE_API_KEY=   # only if that endpoint requires a key
```

Use the same base URL shape you would pass to an OpenAI client (`.../v1`, not the bare host).

### Cheap cloud

```sh
export OMP_PULSE_BASE_URL=https://api.openai.com/v1
export OMP_PULSE_MODEL=gpt-4.1-nano
export OMP_PULSE_API_KEY=sk-...
```

Point `OMP_PULSE_BASE_URL` and `OMP_PULSE_MODEL` at whatever cheap chat model your provider exposes. This key is only for the status strip. It is not the key omp uses for the live turn.

## Does not join the live turn

omp-pulse never calls `prompt`, `steer`, `followUp`, aside delivery, or `sendUserMessage`. A timer tick reads `ctx.sessionManager.getBranch()`, POSTs that tail to the configured endpoint, and writes the line into chrome.

`/pulse` does the same refresh when you ask. The command does not enqueue work on the agent.

Typing `Status?` into the omp prompt is a different path. That text joins the live turn. This strip exists so you do not have to do that.

## Develop

```sh
npm install
npm test
npm run typecheck
```

`npm test` and `npm run typecheck` are the smoke check. A live omp TUI session is not part of that check.

## Publish

The package name on npm is `omp-pulse`. From a checkout, with an npm account that can publish it:

```sh
npm publish --access public
```

The `pi.extensions` field points at `./src/index.ts`, which is the layout omp loads for `omp plugin install`.
