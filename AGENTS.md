# dnscheck Agent Notes

Deploy to Gemini and Render from this local checkout with:

```bash
just deploy
```

This builds `dnscheck:latest` and `dnscheck-contributor:latest` locally, streams
the Docker images to `gemini.local`, and restarts the existing compose service in
`~/server/public/dnscheck`. It then triggers the Render `dnscheck` service deploy
with `render deploys create`.

Use `just deploy-no-cache` when the local Docker and Render build caches should
be ignored.

Gemini should not keep or build from a source checkout for this app. Runtime
configuration stays in `gemini:~/server/public/dnscheck`.

Render deploys from the GitHub-backed service, so commit and push code changes
before relying on the Render side of `just deploy`.
