#cloud-config
# =============================================================================
# P2Party Signaling Server (Caddy + Bun)
# =============================================================================
# Caddy handles TLS termination for signaling.p2party.com.
# Bun runs the signaling server (WebSocket + HTTP).
# =============================================================================
users:
  - name: ${ansible_user}
    groups: users, admin
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      ${ssh_keys}

packages:
  - fail2ban
  - ufw
  - net-tools
  - unzip

package_update: true
package_upgrade: true

write_files:
  - path: /root/setup-signaling.sh
    permissions: '0755'
    content: |
      #!/bin/bash
      set -euo pipefail
      
      APP_USER="${ansible_user}"
      
      # Create app directory
      mkdir -p /home/$APP_USER/server
      chown -R $APP_USER:$APP_USER /home/$APP_USER/server

      # Ansible owns the versioned binary and the port-specific service units.
      # Cloud-init must not create a second, source-based signaling process.
      echo "Signaling host ready (service will be deployed via Ansible)"

runcmd:
  - printf "[sshd]\nenabled = true\nbanaction = iptables-multiport" > /etc/fail2ban/jail.local
  - systemctl enable fail2ban
  - ufw default deny incoming
  - ufw default allow outgoing
  - ufw allow from 10.231.0.0/24 to any port ${ssh_port} proto tcp comment 'SSH from private net'
  - ufw allow 80/tcp comment 'HTTP ACME'
  - ufw allow 443/tcp comment 'HTTPS Caddy'
  - ufw --force enable
  - sed -i -e "/^#*Port /c\Port ${ssh_port}" /etc/ssh/sshd_config
  - sed -i -e '/^\(#\|\)PermitRootLogin/s/^.*$/PermitRootLogin no/' /etc/ssh/sshd_config
  - sed -i -e '/^\(#\|\)PasswordAuthentication/s/^.*$/PasswordAuthentication no/' /etc/ssh/sshd_config
  - sed -i -e '/^\(#\|\)PubkeyAuthentication/s/^.*$/PubkeyAuthentication yes/' /etc/ssh/sshd_config
  - sed -i -e '/^\(#\|\)AuthenticationMethods/s/^.*$/AuthenticationMethods publickey/' /etc/ssh/sshd_config
  - sed -i -e '/^\(#\|\)PermitEmptyPasswords/s/^.*$/PermitEmptyPasswords no/' /etc/ssh/sshd_config
  - sed -i -e '/^\(#\|\)KbdInteractiveAuthentication/s/^.*$/KbdInteractiveAuthentication no/' /etc/ssh/sshd_config
  - sed -i -e '/^\(#\|\)ChallengeResponseAuthentication/s/^.*$/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config
  - sed -i -e '/^\(#\|\)MaxAuthTries/s/^.*$/MaxAuthTries 3/' /etc/ssh/sshd_config
  - sed -i -e '/^\(#\|\)AllowTcpForwarding/s/^.*$/AllowTcpForwarding no/' /etc/ssh/sshd_config
  - sed -i -e '/^\(#\|\)X11Forwarding/s/^.*$/X11Forwarding no/' /etc/ssh/sshd_config
  - sed -i -e '/^\(#\|\)AllowAgentForwarding/s/^.*$/AllowAgentForwarding no/' /etc/ssh/sshd_config
  - sed -i -e '/^\(#\|\)AuthorizedKeysFile/s/^.*$/AuthorizedKeysFile .ssh\/authorized_keys/' /etc/ssh/sshd_config
  - sed -i '$ a AllowUsers ${ansible_user}' /etc/ssh/sshd_config
  - /root/setup-signaling.sh
  - echo "Cloud-init complete" > /root/.provisioning_complete
  - reboot

final_message: "P2Party Signaling ready"
