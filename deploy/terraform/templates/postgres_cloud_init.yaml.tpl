#cloud-config
# =============================================================================
# P2Party PostgreSQL Database Server
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
  - curl
  - wget
  - gnupg2
  - lsb-release
  - net-tools
  - python3-psycopg2

package_update: true
package_upgrade: true

write_files:
  - path: /root/install-postgresql.sh
    permissions: '0700'
    content: |
      ${postgresql_install_script}
  - path: /root/setup-postgres.sh
    permissions: '0755'
    content: |
      #!/bin/bash
      set -euo pipefail
      
      DB_SUBNET="${db_subnet}"
      
      /root/install-postgresql.sh provision

      PG_CONF="/etc/postgresql/19/main/postgresql.conf"
      PG_HBA="/etc/postgresql/19/main/pg_hba.conf"
      
      sed -i "s/#listen_addresses = 'localhost'/listen_addresses = 'localhost'/" $PG_CONF
      
      cat >> $PG_CONF << PGEOF
      
      # P2Party Performance Tuning
      shared_buffers = 1GB
      effective_cache_size = 3GB
      work_mem = 16MB
      maintenance_work_mem = 256MB
      max_connections = 100
      PGEOF
      
      cat >> $PG_HBA << HBAEOF
      
      # P2Party Private Network Access
      hostnossl all all $DB_SUBNET reject
      hostssl all all $DB_SUBNET scram-sha-256
      HBAEOF
      
      systemctl restart postgresql@19-main
      
      echo "PostgreSQL installed - run Ansible playbook to create databases"

runcmd:
  - printf "[sshd]\nenabled = true\nbanaction = iptables-multiport" > /etc/fail2ban/jail.local
  - systemctl enable fail2ban
  - ufw default deny incoming
  - ufw default allow outgoing
  - ufw allow from 10.231.0.0/24 to any port ${ssh_port} proto tcp comment 'SSH from private net'
  - ufw allow from ${db_subnet} to any port 5432 proto tcp comment 'PostgreSQL'
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
  - /root/setup-postgres.sh
  - echo "Cloud-init complete" > /root/.provisioning_complete
  - reboot

final_message: "P2Party PostgreSQL ready"
