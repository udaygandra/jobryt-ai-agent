# Hosting on Oracle Cloud (Always Free)

This guide shows how to run the bot on a free Oracle Cloud Infrastructure (OCI) virtual machine, so it stays online without your own computer.

The stack is small: two containers (n8n and the Telegram bridge) that together use roughly 400 MB of memory when idle. That fits comfortably inside the Always Free allowance.

> Oracle can change its free tier at any time, and it already reduced the Ampere A1 allowance in 2026. Check the current numbers on Oracle's [Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) page before you start.

---

## 1. What you need

- An Oracle Cloud account (a credit or debit card is required for identity verification; it is not charged inside the free limits). Prepaid, virtual and single-use cards are rejected.
- An SSH client (PowerShell on Windows 10/11, or Terminal on macOS/Linux).
- A copy of this project, with a production env file (`.env.prod`) prepared from `.env.example`.
- Your own Telegram bot token and chat ID (see the main README).

One free account is allowed per person. Do not create multiple accounts.

---

## 2. Free tier limits that matter

| Resource | Always Free allowance (as documented in 2026) |
|---|---|
| Arm VM (`VM.Standard.A1.Flex`) | 1,500 OCPU-hours and 9,000 GB-hours per month, shared across the tenancy. This equals 2 OCPUs and 12 GB of memory running all month. |
| Boot + block storage | 200 GB combined |
| Outbound data | 10 TB per month |
| Small x86 VMs | Up to two `VM.Standard.E2.1.Micro` (1 GB memory each). Too small for this project. |

### Choose a small VM on purpose

Use **1 OCPU and 2 GB of memory**, not the maximum.

Oracle may reclaim Always Free instances that look idle. An instance is treated as idle if, over a 7-day period, CPU (95th percentile), network and (for Arm shapes) memory utilization are all below 20%. This bot uses very little CPU and network, so keeping memory use above 20% is what keeps the VM from looking idle. A 2 GB VM does that; a 12 GB VM would not. Oracle's wording is "may be reclaimed", so treat this as a risk to reduce, not a guarantee either way.

You can resize later (Actions, then Edit shape) and stay free as long as the total stays within 2 OCPUs and 12 GB.

---

## 3. Create the account

1. Sign up at [signup.cloud.oracle.com](https://signup.cloud.oracle.com/).
2. Pick your **home region** carefully. It cannot be changed later, and Always Free resources must be created in the home region. Choose the one closest to you.
3. Wait a few minutes after signup for all services to finish registering.

The signup includes a 30-day trial credit. Do not use trial credit to create anything outside the Always Free shapes. Paid resources created during the trial are deleted when it ends.

---

## 4. Create a budget alert (do this first)

This warns you if anything ever starts costing money.

1. Go to **Billing and Cost Management, Budgets, Create Budget**.
2. Scope: compartment. Target: your root compartment. Amount: `1`. Schedule: monthly.
3. Add an alert rule: **Actual spend**, **percentage of budget**, threshold `1`, with your email address as the recipient.
4. Create it, then open the budget and confirm the alert rule lists your email.

A budget only sends a warning. It does not stop spending, so also check **Cost Analysis** now and then.

---

## 5. Create an SSH key (on your computer)

```
ssh-keygen -t ed25519 -f ~/.ssh/oracle_key
```

On Windows PowerShell, use `$HOME\.ssh\oracle_key` for the file path.

This creates two files:

- `oracle_key` is your **private** key. Never share it or upload it anywhere.
- `oracle_key.pub` is your **public** key. You paste this into Oracle.

---

## 6. Create the VM

Go to **Compute, Instances, Create instance** and choose:

| Setting | Value |
|---|---|
| Image | Canonical Ubuntu 24.04 (the Arm / aarch64 build) |
| Type | Virtual machine |
| Capacity type | On-demand |
| Cluster placement group | Off |
| Shape | Ampere, `VM.Standard.A1.Flex`, 1 OCPU, 2 GB memory |
| Networking | Create a new VCN and a new **public** subnet |
| Public IPv4 address | Assign (see below if the toggle is unavailable) |
| SSH keys | Paste the contents of `oracle_key.pub` |
| Boot volume | Default size (about 47 to 50 GB). Do not change the performance setting. |

Before you click **Create**, check that the shape shows the **Always Free-eligible** label. The cost summary may show a list-price estimate for the boot volume. The page itself notes that it does not reflect free-tier pricing. Confirm in Cost Analysis after a day or two that compute and storage show $0.00.

### "Out of host capacity" error

This means Oracle has no free Arm capacity in your region right now. It is temporary. Try, in order:

1. Pick a different availability domain if your region has more than one.
2. Retry later. Early morning and late night often work better.
3. Retry with a slightly different size and resize afterwards.
4. Keep retrying over several days, or use a retry script with the OCI command-line tool.

Upgrading to Pay As You Go can also help with capacity, and Oracle says Always Free resources stay free afterwards. But upgrading cannot be undone, so set the budget alert first and stay inside the free limits.

---

## 7. Give the VM a public IP

If the create form would not let you enable the public IP toggle, add it after the instance is running:

1. Open the instance and go to **Networking, Attached VNICs**, then click the VNIC.
2. Open **IPv4 addresses**.
3. Click the three dots on the private IP, then **Edit**.
4. Set **Public IP type** to **Ephemeral public IP**, give it any name, and click **Update**.

An ephemeral IP is free and stays the same for as long as the instance exists. Note the address, which this guide calls `<PUBLIC_IP>`.

If the option is greyed out or SSH cannot connect, the network is missing something. In **Networking, Virtual cloud networks**, open your VCN and check:

- The subnet is a **public** subnet.
- The VCN has an **Internet Gateway**.
- The subnet's route table has a rule sending `0.0.0.0/0` to that Internet Gateway.
- The security list allows inbound **TCP port 22**.

Keep every other port closed. In particular, do not open the n8n port (5678).

---

## 8. Connect

Run this **on your own computer**, not in Oracle Cloud Shell. Your private key lives on your computer.

```
ssh -i ~/.ssh/oracle_key ubuntu@<PUBLIC_IP>
```

On Windows PowerShell:

```
ssh -i $HOME\.ssh\oracle_key ubuntu@<PUBLIC_IP>
```

Answer `yes` to the fingerprint question the first time.

On Windows, if you see `UNPROTECTED PRIVATE KEY FILE`:

```
icacls $HOME\.ssh\oracle_key /inheritance:r
icacls $HOME\.ssh\oracle_key /grant:r "$($env:USERNAME):(R)"
```

---

## 9. Prepare the VM

Run on the VM:

```
sudo apt update && sudo apt -y upgrade

# Swap file: a safety margin for a 2 GB machine
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER

# Automatic security updates
sudo apt -y install unattended-upgrades
```

Log out (`exit`) and connect again so the Docker group applies. Then check:

```
docker run --rm hello-world
free -h
docker version --format '{{.Server.Arch}}'
```

You should see the hello message, about 2 GB of memory plus 2 GB of swap, and `arm64`.

Do not run `do-release-upgrade`. Stay on the Ubuntu 24.04 LTS release.

---

## 10. Deploy the project

### Copy the project to the VM

From your own computer, in the folder that contains the project. The archive leaves out secrets, git history and local data:

```
tar --exclude=node_modules --exclude=.git --exclude=.env --exclude='.env.*' --exclude='<project-folder>/data' -czf project.tgz <project-folder>
scp -i ~/.ssh/oracle_key project.tgz ubuntu@<PUBLIC_IP>:~
```

Alternatively, run `git clone <repository-url>` on the VM.

### Configure

On the VM:

```
tar xzf project.tgz && cd <project-folder>
mkdir -p data && sudo chown -R 1000:1000 data
cp .env.example .env.prod
nano .env.prod
chmod 600 .env.prod
```

The `chown` matters: n8n runs as user ID 1000 and cannot write to the data folder otherwise.

In `.env.prod`, set at least:

| Variable | Notes |
|---|---|
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_ALLOWED_USER_IDS` | Your own bot and chat. |
| `GEMINI_API_KEY` (or your chosen provider's key) | Your own key. |
| `N8N_ENCRYPTION_KEY` | Generate with `openssl rand -hex 16`. Keep it safe. If you restore existing n8n data, use the same key as before or saved credentials cannot be decrypted. |
| `N8N_HOST_BINDING` | Set to `127.0.0.1` so the editor is not exposed to the internet. |
| `TIMEZONE` | For example `America/Toronto`. |

Never commit `.env.prod`, and never paste real keys into chats, issues or screenshots.

### Start

Only run **one** copy of the bot per Telegram bot token. If it also runs on another machine, stop that one first, or the two will conflict.

```
ENV_FILE=.env.prod docker compose --env-file .env.prod \
  -f docker-compose.yml -f docker-compose.prod.yml up -d
```

`docker-compose.prod.yml` adds memory limits sized for the small VM: n8n capped at 1 GB and the Telegram bridge at 384 MB.

Check that it is healthy:

```
docker compose ps
docker compose logs -f telegram-bridge
docker stats --no-stream
```

Both containers should show as running. Then send your bot a message on Telegram.

If an image tag cannot be found when pulling, edit the pinned version in `docker-compose.yml` to one that exists on Docker Hub.

---

## 11. Open the n8n editor safely

The editor is bound to localhost on the VM, so reach it through an SSH tunnel from your computer:

```
ssh -i ~/.ssh/oracle_key -L 5678:localhost:5678 ubuntu@<PUBLIC_IP>
```

Then browse to `http://localhost:5678` and create the owner account immediately. Keep the tunnel window open while you work. Close it when you are done.

---

## 12. Keep it healthy

- **Memory metric:** after a week, open the instance's **Monitoring** page and check memory utilization. If it stays below 20%, reduce the VM's memory (Actions, Edit shape) if the console allows it.
- **Backups:** a free VM can be lost, so back up the n8n data volume regularly and copy the file off the VM. Find the volume name with `docker volume ls`, then:

  ```
  docker run --rm -v <volume-name>:/d -v "$PWD":/b alpine tar czf /b/n8n_data.tgz -C /d .
  ```

- **Updates:** change the pinned image versions deliberately and test. Do not use `latest` for unattended upgrades.
- **Activity:** Oracle may suspend accounts left idle for 30 days or more. Keep the bot running and sign in to the console occasionally.
- **Billing:** look at Cost Analysis after the first day or two, and again monthly.
- **Support:** Always Free-only accounts have no Oracle Support and no SLA, only community forums.

---

## 13. Troubleshooting

| Problem | Likely cause and fix |
|---|---|
| `Out of host capacity` | Temporary shortage. See section 6. |
| Public IP toggle disabled at creation | Create the instance anyway and add the IP afterwards (section 7). |
| SSH hangs or times out | Missing internet gateway or route rule, or the security list does not allow port 22. |
| `Permission denied (publickey)` | Wrong private key. Use the one that matches the `.pub` you pasted. Also check you are not running the command in Oracle Cloud Shell. |
| `Identity file ... not accessible` | Wrong path. On Windows use `$HOME\.ssh\oracle_key`; Cloud Shell and Linux use forward slashes. |
| `UNPROTECTED PRIVATE KEY FILE` (Windows) | Run the `icacls` commands in section 8. |
| `docker compose ps` says no configuration file | You are not in the project folder. |
| n8n cannot write files | Run `sudo chown -R 1000:1000 data`. |
| Bot does not answer | Another copy is polling with the same token, or a token or chat ID is wrong. Check `docker compose logs telegram-bridge`. |
| Container restarts repeatedly | Memory limit too low or heap too large. Check `docker stats` and the logs. |
| Image tag not found | The pinned version does not exist. Use a real tag from Docker Hub. |
| Install script fails on a very new Ubuntu | Use Ubuntu 24.04 LTS instead. |

---

## 14. Security checklist

- [ ] Only SSH (port 22) is open in the Oracle security list.
- [ ] `N8N_HOST_BINDING=127.0.0.1`.
- [ ] `.env.prod` has permissions `600` and is not in version control.
- [ ] All keys are your own, and any key that was ever shared or committed has been rotated.
- [ ] n8n owner account created; strong password.
- [ ] Budget alert created and the alert rule lists your email.
- [ ] Unattended security updates enabled.
- [ ] Backups copied off the VM.