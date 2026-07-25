#cloud-config
# =============================================================================
# P2Party Coturn TURN/STUN Server
# =============================================================================
# Public-facing server for TURN relay traffic.
# Coturn is installed and configured, but TLS certs are managed by Ansible.
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
  - coturn
  - certbot
  - net-tools

package_update: true
package_upgrade: true

write_files:
  - path: /root/setup-coturn.sh
    permissions: '0755'
    content: |
      #!/bin/bash
      set -euo pipefail
      
      # Enable coturn service
      sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
      
      # Stop coturn until configured by Ansible
      systemctl stop coturn
      systemctl enable coturn
      
      echo "Coturn installed - run Ansible playbook to configure"

runcmd:
  - printf "[sshd]\nenabled = true\nbanaction = iptables-multiport" > /etc/fail2ban/jail.local
  - systemctl enable fail2ban
  - ufw default deny incoming
  - ufw default allow outgoing
  - ufw allow from 10.231.0.0/24 to any port ${ssh_port} proto tcp comment 'SSH from private net'
  - ufw allow 80/tcp comment 'HTTP ACME'
  - ufw allow 443/tcp comment 'TURN TLS'
  - ufw allow 443/udp comment 'TURN UDP'
  - ufw allow 3478/tcp comment 'STUN TCP'
  - ufw allow 3478/udp comment 'STUN UDP'
  - ufw allow ${min_port}:${max_port}/udp comment 'TURN relay range'
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
  - /root/setup-coturn.sh
  - echo "Cloud-init complete" > /root/.provisioning_complete
  - reboot

final_message: "P2Party Coturn ready"
