# Security policy

## Supported versions

Security fixes target the latest published release. Older releases are not
patched; please upgrade before reporting an issue that only affects an older
version.

## Reporting a vulnerability

Do not publish vulnerability details, exploit code, credentials, or session
records in public issues or pull requests.

Use [Report a vulnerability](https://github.com/happyfeetw/tibo-rush/security/advisories/new)
to report vulnerabilities privately through GitHub.

A private report should include the affected Tibo Rush and host versions,
reproduction steps using synthetic data, expected and actual behavior, and the
potential impact. Do not attach real authentication or session files.

## Trust boundary

Tibo Rush runs inside the Oh My Pi or Pi host process. It is not a sandbox and
inherits the host process's filesystem access and privileges. It changes runtime
model settings and writes local coordination and restoration metadata.

`state.json`, `clients/`, `baselines/`, and `handoffs/` can contain session IDs,
working directories, and restore configuration. Keep them private and redact
such data from reports. Tibo Rush does not make model requests itself; the host
and configured providers control model traffic and billing.
