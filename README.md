# omp-pulse

One line of transcript status in the [omp](https://github.com/can1357/oh-my-pi) TUI, refreshed on a timer while a turn is running.

The strip reads the session branch omp already keeps and asks omp's **smol** model role (`modelRoles.smol`) for a single line. By default it paints that line once, with `setWidget` (`belowEditor`). It does not send a prompt, steer, follow-up, or aside into the live turn.

```
+--------------------------------------------------------------+
|  editor                                                      |
+--------------------------------------------------------------+
| pulse · editing the status strip                             |  widget, belowEditor (default)
| git · model · ctx                                            |  native statusline
+--------------------------------------------------------------+
```

`belowEditor` sits above omp's native statusline. A slot under that statusline is still open upstream ([oh-my-pi #11100](https://github.com/can1357/oh-my-pi/issues/11100)). `setFooter` and `setHeader` are no-ops ([oh-my-pi #13473](https://github.com/can1357/oh-my-pi/issues/13473)), so this extension does not call them.

`surface: "both"` paints the same `pulse · …` line with `setWidget` and `setStatus`, so the strip shows up twice. That mode stays available for anyone who wants both chrome slots, and it is usually the wrong setting for a live smoke test. The default is `widget`, which leaves the native statusline for git, model, and context.

On turn start the line is a local extract of progress since the latest user message: what is done, what is in flight, and what is next. It summarizes the turn, so a string of tool calls does not collapse to the last file or command. Vague lines with no object, such as "Running todo" or "Working", are discarded. A blocker still surfaces when the latest real step failed. That extract, and the tail sent to the model, leave out the opening user message, so the line does not restate the prompt. Smol rewrites it on the timer (default 7 minutes) and again when the turn ends, if that progress changed. `/pulse` refreshes on demand.

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

Optional file at `~/.omp/agent/omp-pulse/config.json`. Environment variables override the file. With neither, the extension resolves omp's **smol** role (`ctx.models.resolve("@smol")`, which reads `modelRoles.smol`) and completes through `@oh-my-pi/pi-ai`'s `completeSimple`. The API key comes from `ctx.modelRegistry.getApiKey`. If smol is unresolved, the call fails, or the line is empty or vague, the strip keeps the local extract.

```json
{
  "intervalMs": 420000,
  "refreshWhileIdle": false,
  "surface": "widget",
  "placement": "belowEditor",
  "maxTranscriptChars": 8000,
  "provider": {
    "timeoutMs": 15000
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `intervalMs` | `420000` (7 min) | Model refresh while a turn is running. Clamped to 1 to 30 minutes. Use 300000 to 600000 for the 5 to 10 minute range. |
| `refreshWhileIdle` | `false` | Also run the model refresh when no turn is active, if the transcript changed. |
| `surface` | `widget` | `widget` (`setWidget` only; default), `status` (`setStatus` only), or `both` (same line in both slots, so the strip appears twice; usually wrong for smoke). |
| `placement` | `belowEditor` | `aboveEditor` or `belowEditor`. |
| `maxTranscriptChars` | `8000` | Tail of the branch sent to smol. |
| `provider.baseUrl` | empty | Leave empty to use omp smol. Set an http(s) URL only to opt into a custom OpenAI-compatible endpoint. The extension then POSTs `{baseUrl}/chat/completions`. |
| `provider.model` | empty | Model name for that opt-in endpoint. Ignored when `baseUrl` is empty. |
| `provider.apiKey` | empty | Sent as `Authorization: Bearer` on the opt-in endpoint when set. Smol uses omp's own credential via `modelRegistry`. |
| `provider.timeoutMs` | `15000` | Smol or override request timeout. |

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

### Smol

Configure the cheap model on omp itself, under `modelRoles.smol` (and the credentials omp already stores for that provider). omp-pulse does not pick a model id and does not call a localhost chat endpoint.

A config copied from 0.1.3 that still sets `provider.baseUrl` and `provider.model` opts out of smol. Remove those two keys to use smol again.

### Opt-in OpenAI-compatible endpoint

This is off unless you set both a base URL and a model. It is not the default, and it is separate from the key omp uses for the live turn.

```sh
export OMP_PULSE_BASE_URL=https://api.openai.com/v1
export OMP_PULSE_MODEL=gpt-4.1-nano
export OMP_PULSE_API_KEY=sk-...
```

Use the same base URL shape you would pass to an OpenAI client (`.../v1`, not the bare host).

## Does not join the live turn

omp-pulse never calls `prompt`, `steer`, `followUp`, aside delivery, or `sendUserMessage`. A timer tick reads `ctx.sessionManager.getBranch()`, asks smol for one line, and writes that line into chrome.

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

The package name on npm is `omp-pulse`. GitHub Actions publishes it with npm Trusted Publishing (OIDC). The workflow authenticates with the job's OIDC token. There is no npm token in repository secrets.

1. Bump `version` in `package.json` (semver).
2. Commit that change on main: `chore: release vX.Y.Z`.
3. Tag and push. The tag must match the `package.json` version, with a leading `v`:

```sh
git tag vX.Y.Z && git push origin vX.Y.Z
```

4. `.github/workflows/publish.yml` checks out that tag on a GitHub-hosted runner, installs dependencies, runs `npm test` and `npm run typecheck`, then runs `npm publish --access public`. Authentication is the workflow's OIDC token. Provenance is attached automatically.
5. Fleet and installers:

```sh
omp plugin install omp-pulse
```

`omp plugin install omp-pulse@latest` follows the newest release. Pin a release with `omp plugin install omp-pulse@X.Y.Z`. Re-run install to move a machine; there is no separate update command.

6. Before the first tag publish succeeds, an operator adds a Trusted Publisher on npmjs.com (package settings → Trusted Publisher):

   - Provider: GitHub Actions
   - Repository: `joshuaswarren/omp-pulse`
   - Workflow filename: `publish.yml` (the filename only, not `.github/workflows/publish.yml`)
   - Allowed action: direct `npm publish`

Publishers created after 3 Sep 2026 default to staged publish (`npm stage publish`) only. This workflow calls `npm publish`, so the publisher has to allow that action. npm does not check the configuration when you save it; a mismatch shows up as `ENEEDAUTH` or `E404` on the first publish.

Pushing the `v*` tag is how a release is cut. Publishing a GitHub Release starts the same workflow. If that release points at a tag whose version is already on npm, the second run fails because npm rejects the duplicate version.

The `pi.extensions` field points at `./src/index.ts`, which is the layout omp loads for `omp plugin install`.
