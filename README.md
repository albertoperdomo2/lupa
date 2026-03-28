# lupa

Chrome-style trace viewer for exploring flame graphs, asking questions about a trace, and comparing two runs side by side.

Screenshot coming soon.

## What It Is

`lupa` is a local web app for:

- loading a trace JSON file and inspecting it as an interactive flame graph
- asking `Trace Agent` technical questions about the current trace
- comparing `baseline` vs `candidate` traces in `Deep Mode`
- focusing evidence for findings directly in both flame graphs

## How To Use It

### 1. Install and run

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Open `http://localhost:3000`.

If you want the chat agent, set your OpenAI key in `.env`:

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
