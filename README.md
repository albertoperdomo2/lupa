# lupa

[![CI](https://github.com/albertoperdomo2/lupa/actions/workflows/ci.yml/badge.svg)](https://github.com/albertoperdomo2/lupa/actions/workflows/ci.yml)

Local-first and portable flame graph viewer and trace agent for inspecting and comparing performance traces.

![lupa UI](./assets/lupa.png)

## Run It

```bash
curl -fsSL https://raw.githubusercontent.com/albertoperdomo2/lupa/main/scripts/install.sh | bash
```

This installs the `lupa` CLI, creates `~/.lupa/.env`, pulls the GHCR image, and starts the app at `http://lupa.localhost:3874`.

If you want the URL without a port:

```bash
lupa run --port 80
```

That gives you `http://lupa.localhost`.

Useful commands:

```bash
lupa status
lupa logs
lupa stop
lupa uninstall
```

Loaded traces persist locally on your device and are restored after reload until you clear them from the app.

## What It Does

- Load a trace JSON file and inspect it as an interactive flame graph.
- Ask `Trace Agent` technical questions about the current trace.
- Compare `baseline` and `candidate` traces in `Deep Mode`.
- Focus findings directly in both flame graphs.

## Local Development

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

## Notes

- The viewer works without the agent.
- Trace Agent requires a valid OpenAI API key.
- Deep Mode assumes comparable runs of the same workload and environment.
- Full traces persist in IndexedDB. Chat history persists in local storage.
- Use `Clear Saved Traces` when you want a clean local session.
