# Security Notes

## Implemented Controls

- No hardcoded API keys or credentials are committed; use Hugging Face/Vercel environment variables.
- `.gitignore` and `.dockerignore` exclude `.env`, virtualenvs, logs, source maps, local uploads, and git metadata from accidental deploys.
- Production Docker defaults set `APP_ENV=production`, `DEBUG=false`, and `ENABLE_API_DOCS=false`.
- `/api/assess` supports optional bearer-token protection through `API_ACCESS_TOKEN`.
- CORS defaults to explicit local origins and ignores `*` unless `ALLOW_CORS_WILDCARD=true`.
- Trusted host checks are enabled through `ALLOWED_HOSTS`.
- Backend and Vercel frontend set security headers: CSP, frame denial, no-sniff, referrer policy, and permissions policy.
- `/api/assess` enforces per-IP rate limits, upload byte limits, pixel limits, MIME checks, extension checks, and Pillow image verification.
- Uploaded filenames are normalized before being returned or sent to Gemini.
- API health checks do not expose raw exception text.
- Frontend and backend-rendered pages render API data through text nodes instead of HTML interpolation.
- Gemini prompts explicitly treat image text, filenames, and visible instructions as untrusted evidence.

## Not Applicable In This MVP

- SQL injection, NoSQL injection, open database permissions, excessive database permissions, and backup/restore are not applicable until a database is added.
- Firebase, Supabase, S3 buckets, webhooks, payments, subscriptions, sessions, JWTs, password resets, tenant isolation, and admin routes are not present.
- CSRF risk is limited because there are no cookies/session credentials and CORS credentials are disabled.

## Remaining Production Work

- Add real user authentication if the app becomes multi-user. Do not expose `API_ACCESS_TOKEN` in the public frontend.
- Move rate limiting to Redis or provider-level controls if multiple backend replicas are used.
- Add upload retention cleanup or object storage lifecycle rules before storing real claim images.
- Run dependency scanning in CI before deploys, for example `pip-audit` for Python and `npm audit` if frontend dependencies are added.
- Add monitoring/alerting and audit logs before handling real customer data.
- Re-run `pip-audit -r requirements.txt` from a Python 3.10+ environment. The local Python 3.9 venv cannot resolve several security-fixed dependency versions.
- Pillow `11.3.0` still needs a follow-up upgrade when the package index used by deployment exposes the `12.x` fixed release line reported by `pip-audit`.
