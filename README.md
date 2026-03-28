# 🔎 lupa

Chrome-style trace viewer for exploring flame graphs, asking questions about a trace, and comparing two runs side by side.

![lupa UI](./assets/lupa.png)

## Run It

```bash
curl -fsSL https://raw.githubusercontent.com/albertoperdomo2/lupa/main/scripts/install.sh | bash
```

That installs a tiny `lupa` CLI, creates `~/.lupa/.env`, pulls the published container image from `ghcr.io`, and starts the app in the background at `http://lupa.localhost:3874`.

If you want the URL without a port, run on port `80`:

```bash
lupa run --port 80
```

That gives you `http://lupa.localhost`. It may require permission to bind a low port on your machine.

If you are running a fork, override the image or raw install base:

```bash
LUPA_IMAGE=ghcr.io/<owner>/lupa:latest \
LUPA_INSTALL_BASE_URL=https://raw.githubusercontent.com/<owner>/lupa/main \
curl -fsSL https://raw.githubusercontent.com/<owner>/lupa/main/scripts/install.sh | bash
```

Useful commands:

```bash
lupa status
lupa logs
lupa stop
lupa uninstall
```

Loaded traces persist locally on your device and are restored after reload until you clear them from the app.

## What It Is

`lupa` is a local web app for:

- loading a trace JSON file and inspecting it as an interactive flame graph
- asking `Trace Agent` technical questions about the current trace
- comparing `baseline` vs `candidate` traces in `Deep Mode`
- focusing evidence for findings directly in both flame graphs

## How To Use It

### 1. Contributor setup

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Open `http://localhost:3000`.

If you want Trace Agent locally in dev mode, set your OpenAI key in `.env`:

```env
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.4
```

### 2. Load a trace

Use `Load Trace File` and open a Chrome trace JSON file.

In `Single Trace` mode you can:

- pan and zoom the flame graph
- select spans and inspect details
- capture screenshots for chat
- attach the current selected span to the agent

### 3. Ask Trace Agent

Use the chat panel to ask focused questions such as:

- what is taking the most time here?
- what are these spikes?
- why is this span slow?
- what changed after I loaded the new trace?

You can also paste a GitHub repo URL in chat. It will attach as `@org/repo`, and the agent can read files from that repo when needed.

### 4. Compare two traces

Switch to `Deep Mode` to load:

- a `baseline` trace
- a `candidate` trace

The app computes structured findings, explains the top differences, and lets you click `Focus Evidence` to zoom both flame graphs to the relevant region.

## Notes

- The viewer is useful without the agent.
- The agent features require a valid OpenAI API key.
- Deep Mode assumes both traces are comparable runs of the same workload and environment.
- The one-click install uses `http://lupa.localhost:3874` on purpose. It avoids `/etc/hosts` edits, local TLS setup, and port-80 conflicts while still feeling like a local app instead of a dev server.
- Full trace payloads persist locally in IndexedDB. Chat history stays in local storage. Use `Clear Saved Traces` in the app when you want a clean session.
