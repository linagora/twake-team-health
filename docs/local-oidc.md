# Local OIDC with Keycloak

How to run the app against a real OIDC provider locally (verified end to end:
sign-in, identity, per-user team persistence, sign-out). In dev with no
`OIDC_ISSUER` the app auto-bypasses auth; these steps exercise the real flow.

## 1. Start Keycloak

```sh
docker run -d --name keycloak -p 8080:8080 \
  -e KEYCLOAK_ADMIN=admin -e KEYCLOAK_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:24.0 start-dev
```

## 2. Create a realm, client, and user

The client is confidential (authorization code + PKCE) and its redirect URI must
match the app's callback, `<ORIGIN>/auth/callback/oidc`. Below assumes the app on
`http://localhost:5170`.

```sh
kc() { docker exec keycloak /opt/keycloak/bin/kcadm.sh "$@"; }

kc config credentials --server http://localhost:8080 --realm master \
  --user admin --password admin

kc create realms -s realm=teamhealth -s enabled=true

kc create clients -r teamhealth \
  -s clientId=team-health -s enabled=true -s protocol=openid-connect \
  -s publicClient=false -s standardFlowEnabled=true \
  -s 'redirectUris=["http://localhost:5170/auth/callback/oidc"]' \
  -s 'webOrigins=["http://localhost:5170"]'

# Copy the "value" from this into OIDC_CLIENT_SECRET:
CID=$(kc get clients -r teamhealth -q clientId=team-health --fields id --format csv --noquotes | tail -1)
kc get clients/$CID/client-secret -r teamhealth

kc create users -r teamhealth -s username=alice -s enabled=true \
  -s email=alice@example.com -s emailVerified=true -s firstName=Alice -s lastName=Tester
kc set-password -r teamhealth --username alice --new-password alice123
```

## 3. Run the app with auth enabled

`AUTH_DISABLED` must be unset (a non-`true` value is fine), and a fixed port is
needed so the redirect URI matches.

```sh
AUTH_DISABLED= \
OIDC_ISSUER=http://localhost:8080/realms/teamhealth \
OIDC_CLIENT_ID=team-health \
OIDC_CLIENT_SECRET=<secret from step 2> \
AUTH_SECRET=<any 32+ char string> \
ORIGIN=http://localhost:5170 \
  pnpm dev --port 5170 --strictPort
```

Open http://localhost:5170, sign in as `alice` / `alice123`. Custom teams are then
persisted per user (keyed by the OIDC subject) when `DATABASE_URL` is set.

## Notes

- `/auth/csrf` returns 404 by design: @auth/sveltekit (Auth.js v5) uses
  SvelteKit's origin-based CSRF, so the `[auth][warn][csrf-disabled]` log line is
  expected, not an error.
- In a production build a missing `OIDC_ISSUER` does NOT disable auth (fail
  closed); the app stays locked until SSO is configured.
