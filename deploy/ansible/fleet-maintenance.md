# Ubuntu package maintenance

Run `playbooks/fleet-apt-maintenance.yml` from `deploy/ansible` with the same controller, inventory and vault configuration used for deployments. `plan` reads the configured APT repositories and simulates an in-release upgrade. Refresh the package indices before creating the plan. Each digest covers the selected host and the exact package version transitions.

```sh
ansible-playbook playbooks/fleet-apt-maintenance.yml --limit signaling_production
```

Before applying, confirm a working recovery path for that role. Keep the tested database dump and matching signaling binaries for the database host. For the gateway, retain the current WireGuard configuration and known-good kernel, and test a fresh SSH connection over the management route. Record an independent provider-console or rescue route if one is available. If the public management address is unavailable, use the private address and port from the deployed inventory and Terraform state, with strict verification against the gateway’s existing SSH host key. Record the backup or snapshot reference in a private file. A root-owned configuration archive on the host supplements the independent backup.

Supply the reviewed digest and recovery reference as extra variables in a private file. For example, an application during a designated reboot window uses the following values.

```yaml
fleet_apt_action: apply
fleet_apt_plan_sha256: <digest printed for this host>
fleet_apt_recovery: <backup or recovery reference>
fleet_apt_reboot: true
```

```sh
ansible-playbook playbooks/fleet-apt-maintenance.yml --limit signaling_production -e @/private/path/maintenance.yml
```

The playbook saves package selections, configuration, active service names, boot ID and kernel before APT runs. The signaling host also saves its Caddy and running worker binaries and installs the release-pinned Bun. The playbook preserves local conffiles, refuses package removals and new PostgreSQL majors, verifies every planned installed version, and reconnects over SSH after maintenance. It reboots only when Ubuntu requests it and `fleet_apt_reboot` is set. Each apply accepts one host.

After signaling maintenance, check the public `/health` response and verify a room with two peers. Check an actual relay allocation on TURN, the application connection and backup status on PostgreSQL, and reachability of the other three private hosts after gateway maintenance. Schedule the gateway last. Coordinate the database outage with all signaling workers and clients making schema changes.

If APT fails, preserve the receipt printed by the play and inspect `dpkg --audit` and `/var/log/apt/history.log` on that host. Resolve the interrupted transaction before generating a new plan. If the connection fails, retry the verified management route using its known host key. If it remains inaccessible, use an available provider console or rescue route to select the previous kernel, restore network configuration or recover the image. Restoring the saved service configuration and binaries can repair a signaling service failure. Database rollback uses the verified database backup and its matching release. Perform a fresh health check before starting another host.
