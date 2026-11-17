# tejit-np-auto — automations for nonprofits

Free, simple automations that take repetitive work off a nonprofit team's plate. Each one has a plain-language guide written for people who are not technical.

## Automations

| Automation | What it does | Guide | Open the tool | Folder |
|---|---|---|---|---|
| `auto-emailer` | Sends a personal email to many people at once, using a list in a Google Sheet and a Gmail draft as the template. | [Installation guide](google-scripts/auto-emailer/INSTALLATION_GUIDE.md) | [Open NGO Auto Emailer](https://go.tejitpabari.com/tejit-np-auto-emailer) | `google-scripts/auto-emailer` |

Our tools send anonymous usage counts (organization name and counts only). See [Terms](TERMS.md) and [Privacy](PRIVACY.md).

## Get help installing

If you use the **tejit-np-plugin** with your AI assistant, ask it to help you install any automation above. It reads the latest guide from this repo and walks you through it step by step.

## Deploying

Pushing to `main` auto-deploys Apps Script automations (job `deploy` in `.github/workflows/ci.yml`, runs after the `check` job passes). It never runs on pull requests, so the secret is never exposed to them.

- Only automation folders (`<group>/<name>/`, e.g. `google-scripts/<name>/`, or a top-level `<name>/`) with a `deploy.json` are deployed. A folder is redeployed only when its `deploy.json`, `appsscript.json`, `*.gs` or `*.html` changed. Tests, docs and `.md` files are never pushed to Apps Script.
- It runs `clasp push --force` and then `clasp redeploy <deploymentId>`, which updates the **existing** web-app deployment (same URL) with a new version described as `ci <commit sha>`.
- The repo copy of `appsscript.json` and the code overwrite whatever is online: edits made in the Apps Script editor are lost on the next deploy.

**Add a new automation**

1. Create the folder at `google-scripts/<name>/` (see "Adding a new automation" below) with `appsscript.json`, `*.gs`, `*.html`.
2. Create the script once, and do a first manual deployment in the Apps Script editor (Deploy > New deployment > Web app) to get the deployment ID.
3. Add `google-scripts/<name>/deploy.json`: `{"scriptId": "...", "deploymentId": "..."}` (both non-empty strings; script ID is in Project Settings).

**Secret `CLASPRC_JSON`**: run `npx @google/clasp@3.4.1 login`, then save the full contents of `~/.clasprc.json` as the repo Actions secret `CLASPRC_JSON`. If the Google OAuth app is in test mode the token can expire (about 7 days): run `clasp login` again and update the secret. A missing or empty secret fails the deploy with a clear message.

**Run manually**: Actions tab > ci > Run workflow on `main`; optionally enter a folder path (e.g. `google-scripts/auto-emailer`), blank deploys every automation with a `deploy.json`.

## Adding a new automation

1. Create a folder for it inside a group folder, as `<group>/<name>/` (kebab-case, e.g. `google-scripts/thank-you-letters/`). Apps Script automations go in `google-scripts/`.
2. Put the code in that folder, plus an `INSTALLATION_GUIDE.md` written for non-technical users. Keep pictures in `<folder>/docs/images/`.
3. Add **one row** to the Automations table above. Keep the format exactly the same:
   - first column: the automation name in backticks (kebab-case, `^[a-z0-9-]+$`),
   - second: one plain sentence,
   - third: a link to its `INSTALLATION_GUIDE.md`,
   - fourth: an `https://` link to open the tool (or `—` if there is none),
   - fifth (**Folder**): the folder path in backticks, e.g. `google-scripts/<name>`.
   Keep the 5 columns and the heading `Automations` unchanged.
4. Every `INSTALLATION_GUIDE.md` must have a **What you need** section (the plugin reads it) and an **Open the tool** link that is an `https://` link.

The tejit-np-plugin `install-automation` skill reads this table from
<https://raw.githubusercontent.com/tejitpabari99/tejit-np-auto/main/README.md>, so a new row shows up for plugin users without a plugin update.
