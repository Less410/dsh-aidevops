# Publishing dsh-ai-devops to the DSH plugin market

The community catalog ([awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)) is what the market (dshmarket) and the `plugin_market` agent tool search. A plugin gets listed by a **one-file PR**; a listing does not require an npm release, but a version published on npm makes one-click install and version display work.

## 1. Create the GitHub repository

- Owner/name: `<OWNER>/dsh-ai-devops` (public).
- Push this folder as the repo root.
- Add the **`dsh-plugin`** topic (repo page → About → topics) — required by the catalog.
- Keep the repo at least **1 day old** before opening the catalog PR: the catalog CI rejects repos created minutes before the submission.

Update `package.json` first: replace every `OWNER` in `repository`, `homepage` and `bugs` with the real GitHub owner.

## 2. Optional: publish to npm

```sh
npm login          # once
npm publish        # publishes dsh-ai-devops@0.1.0 (name is free on npm as of 2026-11-10)
```

`prepublishOnly` is intentionally absent — the package has no build step (plain ESM). `@deepseek-ai/dsh-tools` is declared as a **peerDependency**: it is supplied by the DSH host at runtime and only installed locally for the test suite.

## 3. Open the catalog PR

Fork [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) and add **one file**: `data/plugins/<OWNER>__dsh-ai-devops.yml`

```yaml
url: https://github.com/<OWNER>/dsh-ai-devops
name: <OWNER>/dsh-ai-devops
category: dev
description:
  en: Bridge an AI DevOps control plane into DSH with four ai_devops tools for health, delivery status, cloud resources and delivery tasks.
  zh: 把 AI DevOps 控制面接入 DSH，提供四个工具：平台健康、交付状态、云资源与交付任务。
```

PR title: `Add dsh-ai-devops`. Do not edit the generated READMEs — the maintainers regenerate them.

## 4. What reviewers check

- `package.json` declares `dsh.bundle` (this repo does).
- The description matches the code (four tools; read-only except `ai_devops_deliver`; production still requires platform approval).
- Repo is active, has real code, and carries the `dsh-plugin` topic.

After the merge the catalog is regenerated on `main`; the plugin then appears in dshmarket (Discover tab) and in any DSH that adds `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json` as an index source.

## Local install check (no registry needed)

```sh
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-ai-devops
```

Restart the host once, then ask the agent for `ai_devops_health`.

Before tagging a release, run the full verification locally:

```sh
npm test       # 11 unit tests, no network
npm run smoke  # real cordis + ToolsService + live platform, needs AI_DEVOPS_AGENT_TOKEN
npm pack --dry-run
```
