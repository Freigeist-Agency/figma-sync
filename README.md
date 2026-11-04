# figma-sync

Automated site synchronization from Figma Dev Mode to GitHub repositories.

When a designer marks mapped sections as **Ready for dev** in Figma, this workflow triggers, fetches node trees and visual renders, writes code changes via Claude Code, verifies the changes against protected files and smoke tests, and publishes a pull request containing side-by-side screenshot comparisons.

---

## Onboarding a Site

### 1. Configure `.figma-sync/map.json`

Create `.figma-sync/map.json` at the root of your site repository:

```json
{
  "fileKey": "HFuZZUOKyUWmXb8yER287l",
  "tokens": "css/tokens.css",
  "assets": "assets/img",
  "protected": [
    "js/**",
    "css/loader.css",
    "tests/**"
  ],
  "checks": "bash tests/ci-smoke.sh",
  "sections": [
    {
      "name": "nav",
      "frames": ["1:1", "1:2"],
      "files": [
        "index.html",
        "impressum.html",
        "datenschutz.html",
        "404.html",
        "css/site.css"
      ],
      "selector": "header.site-header",
      "page": "index.html"
    },
    {
      "name": "footer",
      "frames": ["1:3", "1:4"],
      "files": [
        "index.html",
        "impressum.html",
        "datenschutz.html",
        "404.html",
        "css/site.css"
      ],
      "selector": "footer.site-footer",
      "page": "index.html"
    }
  ]
}
```

Optional top-level `ready` CSS selector (e.g. `"html.is-loaded"`) waits for site loaders before taking section screenshots.

Initialize `.figma-sync/state.json`:
```json
{
  "sections": {}
}
```

### 2. Add the Caller Workflow

Add `.github/workflows/figma-sync.yml` to your site repo (see [`templates/figma-sync.yml`](templates/figma-sync.yml)):

```yaml
name: figma-sync
on:
  repository_dispatch: { types: [figma-ready] }
  workflow_dispatch: { inputs: { force: { type: boolean, default: false } } }
  pull_request: { types: [closed] }
jobs:
  sync:
    if: github.event_name != 'pull_request'
    concurrency: { group: figma-sync, cancel-in-progress: false }
    uses: Freigeist-Agency/figma-sync/.github/workflows/sync.yml@v1
    with:
      node_id: ${{ github.event.client_payload.node_id }}
      change_message: ${{ github.event.client_payload.change_message }}
      force: ${{ inputs.force == true }}
      wait_seconds: ${{ github.event_name == 'repository_dispatch' && 600 || 0 }}
    secrets: inherit
  closed:
    if: github.event_name == 'pull_request' && github.event.pull_request.head.ref == 'figma-sync/run'
    uses: Freigeist-Agency/figma-sync/.github/workflows/closed.yml@v1
    secrets: inherit
```

### 3. Organization Secrets

Ensure the following GitHub Actions secrets are set at the organization level:
- `FIGMA_TOKEN`: Figma Personal Access Token with Dev Mode read, comments, and dev resources scopes.
- `CLAUDE_CODE_OAUTH_TOKEN`: Anthropic subscription OAuth token for Claude Code.

### 4. Enable GitHub Actions PR Creation

In the site repository settings under **Actions** > **General** > **Workflow permissions**:
- Check **Allow GitHub Actions to create and approve pull requests**.

### 5. Register Figma Webhook

Register the Figma file webhook through Forge:

```bash
npm run figma:register --workspace studio -- <fileKey> <owner/repo>
```

---

## Designer Workflow

1. Mark both the desktop and mobile frames of a mapped section as **Ready for dev** in Figma.
2. Wait ~10 minutes for webhook batching and the workflow run to complete.
3. Review the generated pull request on GitHub (branch `figma-sync/run`), inspect screenshot crops and diffs, and merge when approved.
4. When the PR is merged, the Figma frames automatically receive a comment with the merged PR reference.
