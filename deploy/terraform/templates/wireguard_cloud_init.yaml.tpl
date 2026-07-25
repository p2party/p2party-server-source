#cloud-config
# =============================================================================
# P2Party WireGuard Server
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
  - wireguard

package_update: true
package_upgrade: true

write_files:
  - path: /root/setup-wireguard.sh
    permissions: '0755'
    content: |
      #!/bin/bash
      set -euo pipefail

      mkdir -p /etc/wireguard
      chmod 700 /etc/wireguard

      # Placeholder config. Real keys/config are deployed by Ansible.
      if [ ! -f /etc/wireguard/wg0.conf ]; then
        cat > /etc/wireguard/wg0.conf << WGEOF
      [Interface]
      Address = 10.66.0.1/24
      ListenPort = ${wireguard_port}
      PrivateKey = REPLACE_WITH_ANSIBLE_DEPLOYED_KEY

      # Peers are managed by Ansible template.
      WGEOF
      fi

      chmod 600 /etc/wireguard/wg0.conf

      systemctl disable wg-quick@wg0 || true
      echo "WireGuard base setup complete (final config via Ansible)"

runcmd:
  - printf "[sshd]\nenabled = true\nbanaction = iptables-multiport" > /etc/fail2ban/jail.local
  - systemctl enable fail2ban
  - ufw default deny incoming
  - ufw default allow outgoing
  - ufw allow ${ssh_port}/tcp comment 'SSH from anywhere (VPN entry point)'
  - ufw allow ${wireguard_port}/udp comment 'WireGuard VPN'
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
  - /root/setup-wireguard.sh
  - echo "Cloud-init complete" > /root/.provisioning_complete
  - reboot

final_message: "P2Party WireGuard ready"
