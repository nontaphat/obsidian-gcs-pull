# Security policy

Report vulnerabilities through GitHub Security Advisories after the repository is published. Never include OAuth credentials, refresh tokens, bucket names, object names, or vault content in a public report.

## Security model

- The release bundle contains GCS list and download operations only.
- Google OAuth requests the `devstorage.read_only` scope.
- The plugin never uploads, replaces, or deletes GCS objects.
- Remote deletion never deletes a local file.
- Remote paths are validated before any vault write.
- Case-insensitive and Unicode-normalized path collisions are rejected.
- Writes into the vault configuration directory are rejected.
- Locally changed files are backed up before a changed remote generation replaces them.
- OAuth tokens and settings are stored in this vault's plugin `data.json`.
- There is no telemetry or relay server.
