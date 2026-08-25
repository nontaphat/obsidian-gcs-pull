# Contributing

## Development

Use a dedicated test vault. Do not test development builds in your main vault.

```bash
npm install
npm run dev
```

Run all quality checks before opening a pull request:

```bash
npm run check
```

The production build creates `main.js` at the repository root. To test it in Obsidian, copy `main.js`, `manifest.json`, and `styles.css` into `<Vault>/.obsidian/plugins/gcs-pull/`, then reload Obsidian and enable **GCS Pull** under **Settings → Community plugins**.

## Release process

1. Run `npm run check`.
2. Run `npm version patch`, `npm version minor`, or `npm version major`.
3. Push the commit and version tag without a leading `v`.
4. Confirm that GitHub Actions builds and attests `main.js` and `styles.css`.
5. Review and publish the draft GitHub release.

The release tag must exactly match `manifest.json`. Release assets are `main.js`, `manifest.json`, and `styles.css`.
