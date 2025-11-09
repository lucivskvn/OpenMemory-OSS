# Podman Deployment with Quadlet

This document provides instructions for deploying OpenMemory using Podman and systemd integration via Quadlet.

## 1. Overview

This deployment method leverages Podman's Quadlet feature to manage the OpenMemory container as a systemd service. This approach offers several advantages:

- **Rootless Security**: The container runs as a non-root user, enhancing security.
- **Systemd Management**: Start, stop, and monitor the service using standard `systemctl` commands.
- **Auto-start at Boot**: The service can be configured to start automatically when the system boots.
- **No Daemon Required**: Podman operates without a central daemon, improving efficiency and security.

This method is recommended for production deployments, while the `docker-compose.yml` file is suitable for development environments.

## 2. Prerequisites

- Podman version 4.4 or higher.
- A systemd user instance must be enabled.
- Rootless mode requires `subuid` and `subgid` mappings for your user account. You can verify this by running: `grep $USER /etc/subuid /etc/subgid`

## 3. Installation Steps

1. **Create the systemd directory**:
   ```bash
   mkdir -p ~/.config/containers/systemd
   ```

2. **Copy the Quadlet files**:
   ```bash
   cp podman/*.{container,volume} ~/.config/containers/systemd/
   ```

Note: The Quadlet `.container` files reference volumes by their systemd unit names. Recent Podman/Quadlet versions expect the volume unit name with the `.volume` suffix (for example `openmemory-data.volume`). The provided `openmemory.container` file already uses `Volume=openmemory-data.volume:/data:Z`. If you encounter issues where Podman cannot find the volume, verify that `podman volume ls` shows `openmemory-data` and use the volume unit name when copying or troubleshooting.

3. **Create the environment file**:
   ```bash
   mkdir -p ~/.config/openmemory
   cp .env.example ~/.config/openmemory/openmemory.env
   ```

4. **Edit the environment file**:
   - Open `~/.config/openmemory/openmemory.env` in a text editor.
   - Fill in the required values, such as API keys and database paths.

## 4. Deployment Commands

- **Reload systemd**:
  ```bash
  systemctl --user daemon-reload
  ```

- **Start the service**:
  ```bash
  systemctl --user start openmemory.service
  ```

- **Check the status**:
  ```bash
  systemctl --user status openmemory.service
  ```

- **View logs**:
  ```bash
  journalctl --user -u openmemory.service -f
  ```

- **Enable boot persistence**:
  ```bash
  sudo loginctl enable-linger $USER
  ```

## 5. Management Operations

- **Stop the service**: `systemctl --user stop openmemory.service`
- **Restart the service**: `systemctl --user restart openmemory.service`
- **Update the image**:
  ```bash
  podman pull ghcr.io/nullure/openmemory:latest
  systemctl --user restart openmemory.service
  ```

## 6. Troubleshooting

- **Service won't start**: Check the output of `systemctl --user status openmemory.service` and `journalctl --user -u openmemory.service`.
- **Permission denied**: Verify your `subuid`/`subgid` mappings and check for any SELinux-related errors.
- **Port already in use**: Change the `PublishPort` value in the `openmemory.container` file.
- **Image pull timeout**: Increase the `TimeoutStartSec` value in the `openmemory.container` file.
- **Lingering not working**: Verify that the command `loginctl show-user $USER | grep Linger` shows `Linger=yes`.

## 7. Security Considerations

- The container runs in rootless mode, meaning it operates as a non-privileged user.
- SELinux labels are automatically applied to the data volume.
- The `pasta` network mode provides network isolation.

## 8. Backup and Restore

- **Backup the database**:
  ```bash
  podman volume export openmemory-data -o backup-$(date +%Y%m%d).tar
  ```

- **Restore the database**:
  ```bash
  podman volume import openmemory-data backup-YYYYMMDD.tar
  ```

- **Backup the configuration**:
  ```bash
  cp ~/.config/openmemory/openmemory.env backup/
  ```

## 9. Migration from Docker Compose

1. **Stop the Docker containers**: `docker compose down`
2. **Export data from the Docker volume**: `docker cp openmemory:/data ./data-backup`
3. **Import data into a Podman volume**: `podman volume create openmemory-data && podman volume import openmemory-data data-backup.tar`
4. **Start the Podman service**: `systemctl --user start openmemory.service`

## 10. Advanced Configuration

- **Multi-instance deployment**: Create copies of the `.container` files with different names and port mappings.
- **Custom networks**: Create `.network` files to define custom networks for your containers.
- **Resource limits**: Add `Memory=` and `CPUQuota=` options to the `[Service]` section of the `.container` file to set resource limits.
