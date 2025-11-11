# Podman / systemd Quadlet examples

This folder contains example quadlet and podman notes to run OpenMemory under Podman + systemd.

Notes:

- When mounting host directories into containers on SELinux-enabled systems, use the `:Z` option on volumes to apply a shared label, e.g.

  volumes:
  - ./data:/app/data:Z

- These quadlets are examples only. Validate and adapt to your environment before use.

Additional guidance
-------------------

Quickstart (systemd + Podman quadlets):

1. Ensure Podman and podman-quadlets are installed on your host.

2. Create the data directory and set proper permissions:

```bash
sudo mkdir -p /var/lib/openmemory
sudo chown $USER:$USER /var/lib/openmemory
```

3. Build the image locally or pull from registry:

```bash
cd backend
podman build -t openmemory:latest .
# or: podman pull quay.io/yourorg/openmemory:latest
```

4. Use the example quadlets or `podman run` for an ephemeral test:

```bash
podman run -p 8080:8080 -v /var/lib/openmemory:/data openmemory:latest
```

Notes:

- For SELinux-enabled hosts, append `:Z` to volume mounts.
- If you prefer docker-compose style flows, use `podman-compose` or `podman play kube`.

Additional rootless/systemd tips:

- For rootless Podman + systemd setups, enable user namespace remapping by adding `UserNS=keep-id` to the quadlet/unit. This keeps file ownership sensible for the running user.
- Prefer a per-user environment file instead of a system-wide file to avoid leaking secrets between accounts. The recommended path is `%h/.config/openmemory/openmemory.env` (systemd expands `%h` to the user's home).

Step-by-step (user-level systemd + podman quadlets)

1. Install Podman and quadlets support on your host (distribution packages / `podman-quadlets`).

2. Prepare directories and enable lingering so the service can run after logout:

```bash
# create data and config directories
mkdir -p ~/.config/openmemory
mkdir -p ~/.local/share/containers/storage

# enable linger so systemd user units can run after logout
loginctl enable-linger $USER
```

3. Populate a user-scoped env file from the example and secure it:

```bash
cp .env.example ~/.config/openmemory/openmemory.env
chmod 600 ~/.config/openmemory/openmemory.env
# Edit the file and fill in OM_* values (do not commit or share this file)
${EDITOR:-nano} ~/.config/openmemory/openmemory.env
```

4. Install the quadlets (copy the `.container` and `.volume` files into `~/.config/containers/` or use `podman generate systemd` as a template):

```bash
# example: copy to system location for systemd user units (adjust paths per distro)
mkdir -p ~/.config/systemd/user/containers
cp podman/openmemory.container ~/.config/systemd/user/containers/
cp podman/openmemory-data.volume ~/.config/systemd/user/containers/

# reload user units and start
systemctl --user daemon-reload
systemctl --user start openmemory
```

5. Verify service health and logs:

```bash
systemctl --user status openmemory
journalctl --user -u openmemory -f
# check HTTP health endpoint
curl -f http://localhost:8080/health
```

Troubleshooting

- Permission denied on /data writes: Ensure you used `:Z` on the mount and that the host directory ownership maps correctly to your user namespace. Check `/etc/subuid` and `/etc/subgid` exist and include your user.
- Service fails immediately / cannot pull image: increase `TimeoutStartSec` or pre-pull the image with `podman pull` to avoid initial network/pull delays.
- Health check failing: inspect container logs with `podman logs <container>` or `journalctl --user -u openmemory` for fetch errors.
- Subuid/Subgid missing: add an entry for your user in `/etc/subuid` and `/etc/subgid` or install the distro package that configures them for you.

Testing locally with podman run

```bash
podman run --rm --name openmemory -p 8080:8080 -v /var/lib/openmemory:/data:Z docker.io/yourrepo/openmemory:latest
# then in another shell
curl -f http://localhost:8080/health
```

Integration notes

- The quadlet/volume files use `:Z` relabeling for SELinux hosts and `UserNS=keep-id` for rootless UID mapping.
- The Docker-compose setup remains suitable for local multi-container development. For production, use podman quadlets or a Kubernetes manifest generated with `podman play kube`.

If you'd like, I can generate a `kube` YAML manifest from `docker-compose.yml` for `podman play kube`.
