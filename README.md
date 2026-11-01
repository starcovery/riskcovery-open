# Riskcovery open review

This repository holds `marmot`, a Riskcovery core whose agent runs open-weight models, and the runner that drives it. Together they review a website's security on your own machine, with no Riskcovery account.

The agent looks at your site the way any visitor on the internet can. It looks for files and folders left public, protections missing from responses, software with known vulnerabilities, and pages open without a sign-in. It then writes a report that backs each finding with the request it made and the answer it got. Its prompt tells it to only read: to send GET, HEAD, and OPTIONS requests, and never to submit a form, sign in, guess a password, or send an exploit.

## What you need

- Docker, running, because the agent works inside a fresh container.
- Node.js 24 or later.
- An [OpenRouter](https://openrouter.ai) API key. The agent calls the open-weight model named in `core/marmot/.env` through OpenRouter, and the command prints what the review spent on your key. Give reviews a key of their own with a credit limit, which OpenRouter's key settings allow.

## Run a review

```sh
git clone https://github.com/starcovery/riskcovery-open.git
cd riskcovery-open
npm install
export OPENROUTER_API_KEY=<your OpenRouter key>
npm run review -- --practice
```

`--practice` reviews the bundled practice site in `practice-site/`. It is a made-up shop that runs only on your machine, with weaknesses planted on purpose, and every credential in it is fake. Start with it to see a review end to end.

Then review a site you own or are allowed to test:

```sh
npm run review -- --site example.com
```

Options:

- `--mode fast` (the default) or `--mode premium` picks which of the core's two models runs. Premium names a larger model and costs more.
- `--minutes <n>` sets how long the review runs, 15 by default. The agent works in five-minute rounds, and each round starts a fresh conversation that picks up from the report so far.
- `--out <folder>` sets where the report is written, `reports/` by default.

The command prints each finding's title, how many model calls the agent made and on which models, what the review spent on your key, and where the report is. It exits 0 when the review produced a report about the site with at least one finding, made every model call on the mode's model, and, on the practice site, sent no request that writes.

## The report

The report is JSON that matches the schema in `src/document.ts`. It has a title, a status, a summary, and sections whose blocks hold findings, tables, quotes, links, and code. The agent writes it inside its container. At the end of each round the runner keeps the newest version that matches the schema, so a rewrite that breaks the format never replaces a good report.

## How it works

- `core/marmot/.env` is the core: a model for each mode, the Debian packages the agent's box needs, and the prompt that starts each round and the prompt that continues it.
- `box/Dockerfile` builds the agent's box: Debian, Node.js, and Claude Code, run as an unprivileged user that may use `sudo` for the core's packages.
- `src/box.ts` starts the box, installs the core's packages, and runs Claude Code on the mode's model through OpenRouter's Anthropic-compatible endpoint. It runs the rounds, keeps the newest report that matches the schema, and counts the model calls and the models they ran on from Claude Code's transcripts.
- `box/model-relay.mts` runs in a second container beside the box and is the only place your OpenRouter key goes. The agent's box gets only the relay's address, and the relay adds your key to the agent's calls on the mode's model and refuses every other request, so nothing the agent runs can read the key. It also refuses a call that names a control that can move the call to another model or add a paid step, such as `models`, `fallbacks`, `provider`, or `plugins`, or that sets `service_tier`, `speed`, or `inference_geo` to anything but its standard value. It refuses a call that offers a tool with a `type` other than `custom`, which covers OpenRouter's and Anthropic's server tools such as web search; the tools of the box's Claude Code carry no `type`, so they pass. It forwards none of the agent's cookies or proxy and CDN headers, and passes back no cookie OpenRouter sets. `npm test` starts the relay under Node beside a stand-in for OpenRouter and checks with Vitest what it forwards and what it refuses.
- `src/review.ts` is the command above. With `--practice` it also serves `practice-site/` with Caddy on the box's private network and counts the requests that would write to the site.

## What the agent can reach

The agent runs Claude Code with every permission inside its box, so the box is the boundary. The agent only reads because its prompt says so. Nothing outside the model blocks other requests, and the box reaches every network your machine reaches. A site can also put text in its pages that tries to steer the agent. Run reviews on a machine and network where that is acceptable, with a key of their own that has a credit limit. On the practice site, the command counts every request that would write and fails the review if there is one.

## License

[Mozilla Public License 2.0](LICENSE). The license's notice for every file in this repository is in `LICENSE`.
