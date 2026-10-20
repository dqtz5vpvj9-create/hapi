# Device login TLS trust repair

On CHRIS, Bun 1.4.0 fetch to https://auth.openai.com failed with
UNKNOWN_CERTIFICATE_VERIFICATION_ERROR while curl completed certificate validation.
Adding NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt allowed the same Bun
request to complete. The observed leaf issuer was Let's Encrypt YE2; the exact
chain-building difference between Bun's bundled trust and the system bundle was
not established.

Both hapi-runner.service and hapi-native.service now load that system bundle via
~/.config/systemd/user/<service>.service.d/zzzz-system-ca.conf:

```ini
[Service]
Environment=NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
```

This adds the host's maintained trust bundle without disabling TLS validation.
Keep the drop-ins when updating executable paths. Runner device authorization
and bridge token refresh both need this configuration. Only HAPI roles were
restarted; no Codex engine stop was requested.

Production verification: a real device code was obtained, remained pending
without error across eight status checks over 40 seconds, and was cancelled.
Completing personal browser authorization and exchanging the resulting token
were not exercised by this check.
