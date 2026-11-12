---
name: fleet
description: Connect to and manage Drew's machines. Use before running SSH, gcloud, or remote commands on any of them, such as the dev box.
---

# Fleet

Run `hostname` first to learn which machine you're on. Don't SSH to the machine you're already on.

## devbox

NixOS VM `devbox-drew` on GCE, reached over Tailscale. Its `hostname` is `devbox`.

Connect with the gcloud key as Drew's OS Login user. Disable the SSH agent: the 1Password agent prompts and hangs.

```bash
u=$(gcloud compute os-login describe-profile --format='value(posixAccounts[0].username)')
ssh -i ~/.ssh/google_compute_engine -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes -l "$u" devbox-drew '<command>'
```

- That user has passwordless `sudo`. Act as `drew` with `sudo -u drew bash -lc '<command>'`.
- User units: `sudo -u drew XDG_RUNTIME_DIR=/run/user/1000 systemctl --user status t3code`.
- `Permission denied (publickey)`: run `gcloud compute os-login ssh-keys add --key-file ~/.ssh/google_compute_engine.pub`. If the key is missing, create it first with `ssh-keygen -t ed25519 -N '' -f ~/.ssh/google_compute_engine`.
- Tailnet unreachable: `gcloud compute ssh devbox-drew --tunnel-through-iap --zone us-east4-a --project <id>`. The project ID is `gcp:project` in Sheer's `stacks/devbox/Pulumi.drew.yaml`. This repo is public, so it's not here.
- The box runs from Monday 00:00 to Saturday 00:00 ET and is stopped otherwise.
- NEVER reboot, stop, or reset the box. NEVER stop `t3code`: it ends every T3 session.
