# Security Policy

## Reporting a vulnerability

Please **do not open a public GitHub issue** for security vulnerabilities.

Email [privacy@mikekeefe.com](mailto:privacy@mikekeefe.com) with:

- A description of the vulnerability
- Steps to reproduce
- Potential impact

You'll receive a response within 7 days. If the issue is confirmed, a fix will be prioritised and you'll be credited in the release notes unless you prefer otherwise.

## Scope

Relevant security areas for this project:

- OAuth 2.0 token issuance, storage, and revocation
- KV data isolation between users
- Webhook endpoint authentication (`hub.verify_token`)
- Strava API credential handling

## Out of scope

- Vulnerabilities in Cloudflare's infrastructure or the Strava API
- Issues requiring physical access to a device
- Social engineering attacks
