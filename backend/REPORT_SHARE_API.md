# Report share contract

`POST /api/v1/reports/:id/share` accepts `{ "expiresInDays": 7 | 30 | 90 }`; omission defaults to `30`. Values outside this allowlist, including strings, are rejected. The response returns:

```json
{
  "token": "…",
  "pagePath": "/shared-reports/…",
  "path": "/shared-reports/…",
  "apiPath": "/api/v1/shared-reports/…",
  "expiresInDays": 7,
  "expiresAt": "…"
}
```

`pagePath` is the canonical browser route. `path` is a backward-compatible alias and must not be treated as the API route. `GET /api/v1/shared-reports/:token` keeps the `{ report }` envelope and returns only the minimized public DTO. `DELETE /api/v1/reports/:id/share` revokes the active link.
