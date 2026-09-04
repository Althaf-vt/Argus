# Manual Surveillance Trigger Runbook

Execute ad-hoc page checks via cURL:
```bash
curl -X POST http://localhost:3000/api/fetch-page -d '{"url":"[https://example.com](https://example.com)"}'
```
