# examples/sdk-usage

The SDK surface against a real host: define a deployment in TS, then deploy,
read status, scale and roll back - no `deploy.yml`, no CLI config.

```sh
BUNDANT_E2E_HOST=root@192.168.2.104 \
BUNDANT_E2E_RUNTIME=docker \
BUNDANT_E2E_PREFIX=sdksmoke \
BUNDANT_E2E_PROXY_HOST=sdksmoke-docker.test \
bun run main.ts
```

Output (one line per step, checked by the dual-host smoke script):

```text
deployed rev=sdk1 live=1/1
redeployed rev=sdk2 live=1/1
scaled replicas=2 live=2
rolled back to sdk1 live=1/1
```

`replicas` in the spec is 1, so `expected` stays 1 after `scale 2` - the row
reports live 2, the same drift the CLI shows. The embedded autoscaling sample
from the spec belongs to SDK-4, once `bundant.stats` exists.
