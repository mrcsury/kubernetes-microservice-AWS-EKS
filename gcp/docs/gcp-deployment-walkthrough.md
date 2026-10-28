# MySocialSpace: GCP GKE deployment walkthrough

This beginner-friendly guide deploys the existing application to Google Cloud using the mirrored architecture in `gcp/architecture-diagram.html`. It is Google Cloud Console first. Use PowerShell and Docker Desktop for local steps and Kubernetes tasks the Console cannot perform.

- **Application:** frontend plus auth, post, and comment services; two replicas per application.
- **Cloud services:** Artifact Registry, VPC, Cloud NAT, GKE Standard, Cloud SQL for MySQL, Cloud DNS.
- **Traffic:** Browser → Cloud DNS → GKE external passthrough Network Load Balancer → NGINX Ingress → ClusterIP service → application pod → private Cloud SQL.
- **Example region:** `asia-south1` (Mumbai). Keep resources in compatible regions.
- **Cost:** this lab creates billable resources. A budget alert only sends alerts; it does not stop charges. Complete cleanup at the end.

> GCP manifests are under `gcp/k8s/`; GCP-specific application source and Dockerfiles are copied under `gcp/application/` so the GCP deployment track is self-contained. Do not edit AWS files for this walkthrough.

## Contents

1. [Before starting](#1-before-starting)
2. [Choose project values](#2-choose-project-values)
3. [Prepare the Google Cloud project](#3-prepare-the-google-cloud-project)
4. [Create the VPC and subnet](#4-create-the-vpc-and-subnet-in-the-console)
5. [Set up private access and Cloud NAT](#5-set-up-private-access-and-cloud-nat-in-the-console)
6. [Create Artifact Registry repositories](#6-create-artifact-registry-repositories-in-the-console)
7. [Build and push images](#7-build-and-push-images-with-docker-desktop)
8. [Create Cloud SQL](#8-create-cloud-sql-for-mysql-in-the-console)
9. [Create GKE Standard](#9-create-gke-standard-in-the-console)
10. [Install local tools and connect](#10-install-local-tools-and-connect)
11. [Set image names](#11-set-image-names-in-the-gcp-manifests)
12. [Create namespace and Secret](#12-create-the-namespace-and-database-secret)
13. [Check database connectivity](#13-check-private-database-connectivity)
14. [Create database tables](#14-create-database-tables-with-prisma-jobs)
15. [Deploy the applications](#15-deploy-the-four-applications)
16. [Reserve the ingress IP and install NGINX Ingress](#16-reserve-the-ingress-ip-and-install-nginx-ingress)
17. [Use GoDaddy and Cloud DNS](#17-use-godaddy-and-cloud-dns)
18. [Enable HTTPS](#18-enable-https-with-cert-manager)
19. [Verify](#19-verify-the-application)
20. [Clean up](#20-clean-up)
21. [Troubleshooting](#21-troubleshooting)

## 1. Before starting

You need a Google account with project and billing permissions, a billing account, this repository cloned locally, and a domain you control for public DNS/HTTPS. Install Docker Desktop and switch it to **Linux containers**. Install Google Cloud CLI (`gcloud`), `kubectl`, and Helm on Windows. You will not run the website locally. Docker Desktop is only used to build container images from the GCP-local source folder; the images are pushed to Google Cloud. `gcloud`, `kubectl`, and Helm run the cloud/Kubernetes setup tasks that the Console does not conveniently provide.

```powershell
docker version
docker info --format '{{.OSType}}'
```

The second command should print `linux`; images below target `linux/amd64`.

## 2. Choose project values

Record the values you already know: your registered domain (without `https://`), email for Let's Encrypt, and region `asia-south1`. To find your current public IPv4 address, open a browser and search `what is my IP`; record the IPv4 result and add `/32` when you enter it in Step 9. You will record the Project ID in Step 3. Some values do not exist yet; collect those from the indicated later step. Never run a command with a placeholder still in it. Replace each placeholder with the real value, without the angle brackets. Do not save or commit passwords.

### Value hand-off list

Keep this table open while you work. After each source step, copy its result into your private notes. The later step tells you where to paste it. If you have not reached the source step yet, leave that value blank and continue only through the earlier steps. Do not guess values or copy the example values as your own.

| Value to record | Where you get it | Where you use it |
|---|---|---|
| `<PROJECT_ID>` | Step 3: project selector / project details in Cloud Console | Step 7: Docker image names; Step 10: `gcloud get-credentials`; Step 11: GCP manifest image paths |
| `<DOMAIN>` and `<EMAIL>` | Step 2: your registered domain and email address | Step 17: Cloud DNS zone and GoDaddy; Step 18: Ingress host rules and ClusterIssuer email |
| `<YOUR_PUBLIC_IP>` | Step 2: your current internet public IP (include `/32`) | Step 9: GKE control-plane authorized networks |
| `<SQL_PRIVATE_IP>` | Step 8: Cloud SQL instance overview, after it is RUNNABLE | Steps 12 and 13: database Secret and connectivity check |
| SQL admin password | Step 8: when you create the `admin` database user; keep it private | Step 12: type it at the secure PowerShell prompt; Step 14 Jobs use the resulting Secret |
| GKE node service account email | Step 9: node pool details | Step 10: grant Artifact Registry Reader |
| `<INGRESS_IP>` | Step 16: the reserved regional static IP address | Step 16: `ingress-nginx-values.yaml`; Step 17: both Cloud DNS A records and DNS checks |
| Four Cloud DNS name servers | Step 17 Part A: Cloud DNS zone **Registrar setup** | Step 17 Part B: GoDaddy custom nameserver setting |

The literal placeholder `<SQL_PASSWORD>` appears only in the optional SQL grant example in Step 8. Use your actual chosen password in Cloud SQL Studio; do not put it in a source file.

## 3. Prepare the Google Cloud project

In Google Cloud Console, select/create the project and link billing. Copy the exact **Project ID** shown in the project selector or project details; later Docker and `gcloud` commands require this ID, not the project display name. Under **APIs & Services → Library**, enable Kubernetes Engine, Artifact Registry, Cloud SQL Admin, Compute Engine, Cloud DNS (`dns.googleapis.com`), Service Networking, and Cloud Resource Manager APIs. If the Console prompts to enable another API during resource creation, enable it for this project. Under **Billing → Budgets & alerts**, create an alert at an amount you can afford. An alert does not cap spending.

**Checkpoint:** correct project selected and billing enabled.

## 4. Create the VPC and subnet in the Console

A VPC is the private network shared by GKE and Cloud SQL.

1. Open **VPC network → VPC networks → Create VPC network**. Name it `blog-vpc`, use custom subnet creation.
2. Create subnet `blog-subnet` in `asia-south1`, primary IPv4 range `10.10.0.0/20`.
3. Add secondary ranges `blog-pods` = `10.20.0.0/16` and `blog-services` = `10.30.0.0/20`.
4. Enable **Private Google Access** on the subnet so private nodes can reach Google APIs.
5. Create the network. GKE will create the specific firewall rules it needs for cluster communication and its LoadBalancer Service. Do not create broad internet firewall rules.

**Checkpoint:** VPC and subnet show the primary and secondary ranges, and Private Google Access is enabled.

## 5. Set up private access and Cloud NAT in the Console

Cloud SQL private IP requires Private Services Access. Cloud NAT provides outbound internet access to private nodes without giving each node a public IP.

**Private Services Access:** In **VPC network → VPC networks → blog-vpc → Private services access**, allocate a non-overlapping internal range named `blog-sql-range` (for example `10.40.0.0/16`) and create a private connection to `servicenetworking.googleapis.com`.

**Cloud NAT:** In **VPC network → Cloud NAT**, create router `blog-router` and gateway `blog-nat` in `asia-south1` on `blog-vpc`. Automatic NAT IP allocation is fine for this lab. Include all subnet ranges (primary and secondary) as NAT sources. Create it.

**Checkpoint:** PSA connection is established and Cloud NAT is attached to the VPC in the selected region.

## 6. Create Artifact Registry repositories in the Console

Artifact Registry stores the private container images. In **Artifact Registry → Repositories → Create repository**, create four **Docker**, **Standard**, regional repositories in `asia-south1`: `blog-frontend`, `blog-auth-service`, `blog-post-service`, and `blog-comment-service`. Then open **IAM & Admin → IAM**, choose **Grant access**, enter the Google account you will use with `gcloud auth login`, and grant **Artifact Registry Writer** (`roles/artifactregistry.writer`) so your computer can upload images.

**Checkpoint:** four repositories appear. They are empty until you push images.

## 7. Build and push images with Docker Desktop

The Console cannot build from your local source tree. Open PowerShell at the repository root. Before running the following block, replace `<PROJECT_ID>` with the ID you copied in Step 3 and remove the angle brackets. Sign in and configure Docker credentials:

```powershell
gcloud auth login
gcloud config set project <PROJECT_ID>
gcloud auth configure-docker asia-south1-docker.pkg.dev
```

Before running this block, replace every `<PROJECT_ID>` with the Project ID recorded in Step 3. Do not leave angle brackets in image names. Build and push each image (repository paths must match the Artifact Registry names):

```powershell
docker build --platform linux/amd64 -t asia-south1-docker.pkg.dev/<PROJECT_ID>/blog-auth-service/blog-auth-service:latest ./gcp/application/services/auth-service
docker push asia-south1-docker.pkg.dev/<PROJECT_ID>/blog-auth-service/blog-auth-service:latest
docker build --platform linux/amd64 -t asia-south1-docker.pkg.dev/<PROJECT_ID>/blog-post-service/blog-post-service:latest ./gcp/application/services/post-service
docker push asia-south1-docker.pkg.dev/<PROJECT_ID>/blog-post-service/blog-post-service:latest
docker build --platform linux/amd64 -t asia-south1-docker.pkg.dev/<PROJECT_ID>/blog-comment-service/blog-comment-service:latest ./gcp/application/services/comment-service
docker push asia-south1-docker.pkg.dev/<PROJECT_ID>/blog-comment-service/blog-comment-service:latest
docker build --platform linux/amd64 -t asia-south1-docker.pkg.dev/<PROJECT_ID>/blog-frontend/blog-frontend:latest ./gcp/application/frontend
docker push asia-south1-docker.pkg.dev/<PROJECT_ID>/blog-frontend/blog-frontend:latest
```

The GCP-local frontend copy has `VITE_API_URL` empty in its `.env.production`; this makes browser requests same-origin `/api/...`, which the GCP Ingress routes. Do not add the AWS hostname or a separate API URL build argument. The manifests use `latest` for this lab; after rebuilding, push and restart the matching Deployment. Build from `gcp/application/` so Docker uses only the GCP-local source copy.

**Checkpoint:** each Artifact Registry repository shows an image. If push is denied, check your user has Artifact Registry Writer and rerun `gcloud auth configure-docker`.

## 8. Create Cloud SQL for MySQL in the Console

1. In **Cloud SQL → Create instance → MySQL**, choose MySQL 8.0, instance ID `blog-mysql`, a strong root password, region `asia-south1`, and a small single-zone configuration suitable for a lab. High availability costs more.
2. In connections select **Private IP** and network `blog-vpc`. PSA from Step 5 must be established. Do not enable public IP.
3. Choose a suitable small storage size and create the instance. Wait until `RUNNABLE`; record its private IP.
4. Create a database user `admin` with a strong password and databases `auth_db`, `posts_db`, and `comments_db`.
5. In Cloud SQL Studio connect as root and, if required, grant the application account access (replace password):

```sql
CREATE USER IF NOT EXISTS 'admin'@'%' IDENTIFIED BY '<SQL_PASSWORD>';
GRANT ALL PRIVILEGES ON auth_db.* TO 'admin'@'%';
GRANT ALL PRIVILEGES ON posts_db.* TO 'admin'@'%';
GRANT ALL PRIVILEGES ON comments_db.* TO 'admin'@'%';
FLUSH PRIVILEGES;
```

Choose a URL-safe letters-and-numbers password to avoid URL-encoding problems in `DATABASE_URL`.

**Checkpoint:** instance is RUNNABLE, private IP is shown, and all three databases exist.

## 9. Create GKE Standard in the Console

GKE Standard is the managed Kubernetes cluster. Its worker nodes are Compute Engine VMs. This setup uses private worker IPs and spreads the regional cluster across three zones.

1. Open **Kubernetes Engine → Clusters → Create → GKE Standard**.
2. In **Cluster basics**, enter name `blog-gke`, choose **Regional**, region `asia-south1`, and the **Regular** release channel. In the Kubernetes version control, select a supported `1.35.x` patch version if the Console offers one; Step 16 explains why. Do not automatically accept a newer default version for this learning setup.
3. Under **Networking**, select VPC `blog-vpc` and subnet `blog-subnet`. Enable VPC-native traffic, then assign the existing Pod secondary range `blog-pods` and Service secondary range `blog-services`.
4. Under **Security / Access**, enable **Private nodes**. Keep the control-plane external endpoint enabled so your computer can administer the cluster, then enable control-plane authorized networks and add the public IP you recorded in Step 2 as `<YOUR_PUBLIC_IP>/32` (replace the placeholder and include `/32`). This exposes only the management endpoint to your IP; it does not make the worker nodes public. Do not use `0.0.0.0/0`.
5. Configure the first/default node pool as `blog-workers`. Select three zones in `asia-south1`, machine type `e2-medium`, and set **Number of nodes per zone** to `1` (three worker VMs total). Regional GKE Standard clusters can default to three nodes per zone, or nine total, so check this field carefully. Leave node autoscaling off for this fixed-size lab. Use the default node service account and note its email for Step 10.
6. Ensure the HTTP load balancing and metrics / Horizontal Pod Autoscaling support are enabled. Create the cluster and wait for status **Ready**.

**Checkpoint:** cluster `blog-gke` is Ready, has three private worker nodes total (one per selected zone), and your current public IP is on the control-plane authorized networks list.
## 10. Install local tools and connect

Install `gcloud`, `kubectl`, and Helm if missing. In **IAM & Admin → IAM**, grant the GKE node service account email you recorded in Step 9 **Artifact Registry Reader** (`roles/artifactregistry.reader`); this allows nodes to pull images and is separate from your image push permission. Before running the command below, replace `<PROJECT_ID>` with the Step 3 value and remove the brackets.

```powershell
gcloud container clusters get-credentials blog-gke --region asia-south1 --project <PROJECT_ID>
kubectl get nodes
```

**Checkpoint:** three nodes show `Ready`. If forbidden/unreachable, check your current IP is authorized and refresh credentials.

## 11. Set image names in the GCP manifests

In VS Code Find in Files, scope search to `gcp/k8s/` and replace every `YOUR_PROJECT_ID` with the exact Project ID recorded in Step 3. Confirm the image paths begin with `asia-south1-docker.pkg.dev/` followed by your real project ID and repository names. Save the files. Do not edit root `k8s/`; leave `YOUR_DOMAIN` and `YOUR_EMAIL` for Step 18.
## 12. Create the namespace and database Secret

A Kubernetes Secret stores connection strings without putting them in YAML. Use Cloud SQL's private IP. Run from the repository root in PowerShell. First replace `<SQL_PRIVATE_IP>` in each of the three URL lines with the actual private IP recorded in Step 8; remove the angle brackets. When PowerShell prompts, type the same Cloud SQL `admin` password you created in Step 8. The command then constructs the three database URLs and saves them in the Kubernetes Secret.

```powershell
kubectl apply -f gcp/k8s/namespace.yaml
$dbPassword = Read-Host 'Cloud SQL admin password' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($dbPassword)
try { $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
$authUrl = "mysql://admin:${plainPassword}@<SQL_PRIVATE_IP>:3306/auth_db"
$postsUrl = "mysql://admin:${plainPassword}@<SQL_PRIVATE_IP>:3306/posts_db"
$commentsUrl = "mysql://admin:${plainPassword}@<SQL_PRIVATE_IP>:3306/comments_db"
$jwtSecret = Read-Host 'Long random JWT secret' -AsSecureString
$jwtBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($jwtSecret)
try { $jwtPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($jwtBstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($jwtBstr) }
kubectl create secret generic blog-secrets -n blog --from-literal=db-auth-url=$authUrl --from-literal=db-posts-url=$postsUrl --from-literal=db-comments-url=$commentsUrl --from-literal=jwt-secret=$jwtPlain
Remove-Variable plainPassword,authUrl,postsUrl,commentsUrl,jwtPlain -ErrorAction SilentlyContinue
```

Do not share the terminal while entering secrets. Confirm only the Secret name (not contents): `kubectl get secret blog-secrets -n blog`.

## 13. Check private database connectivity

Replace `<SQL_PRIVATE_IP>` with the private IP recorded in Step 8 before running. This ephemeral utility pod checks the network route to MySQL (not the password):

```powershell
kubectl run db-network-check -n blog --rm -it --restart=Never --image=busybox:1.36 -- nc -vz <SQL_PRIVATE_IP> 3306
```

If it times out, check VPC, subnet, private IP, and PSA. Do not expose Cloud SQL publicly to work around a private-routing problem.

## 14. Create database tables with Prisma Jobs

Run the three one-off jobs before starting services:

```powershell
kubectl apply -f gcp/k8s/schema-jobs.yaml
kubectl get jobs,pods -n blog
```

Wait for all three Jobs to show `1/1` completions. For a failure, inspect e.g. `kubectl logs job/prisma-push-auth -n blog`. Check connection strings, credentials, grants, and database names.

## 15. Deploy the four applications

The three backend HPAs keep at least two replicas and can scale up to five based on CPU; the frontend remains at two. Apply each file explicitly so it is clear what is being created.

```powershell
kubectl apply -f gcp/k8s/auth-service/deployment.yaml
kubectl apply -f gcp/k8s/auth-service/service.yaml
kubectl apply -f gcp/k8s/auth-service/hpa.yaml
kubectl apply -f gcp/k8s/post-service/deployment.yaml
kubectl apply -f gcp/k8s/post-service/service.yaml
kubectl apply -f gcp/k8s/post-service/hpa.yaml
kubectl apply -f gcp/k8s/comment-service/deployment.yaml
kubectl apply -f gcp/k8s/comment-service/service.yaml
kubectl apply -f gcp/k8s/comment-service/hpa.yaml
kubectl apply -f gcp/k8s/frontend/deployment.yaml
kubectl apply -f gcp/k8s/frontend/service.yaml
```

Check that Kubernetes accepted them and wait for each Deployment:

```powershell
kubectl get deployments,pods,services,hpa -n blog
kubectl rollout status deployment/auth-service -n blog
kubectl rollout status deployment/post-service -n blog
kubectl rollout status deployment/comment-service -n blog
kubectl rollout status deployment/frontend -n blog
```

**Checkpoint:** four Deployments are available, with eight application pods Ready (two per application). If a rollout stalls, inspect `kubectl describe pod <POD_NAME> -n blog` and `kubectl logs <POD_NAME> -n blog`.

## 16. Reserve the ingress IP and install NGINX Ingress

NGINX Ingress routes web paths to the app's ClusterIP Services. Its `LoadBalancer` Service asks GKE to create the external passthrough Network Load Balancer. Reserve the address before installing the controller so GKE creates the load balancer with the permanent IP from the start.

**Compatibility and lifecycle caveat:** the community ingress-nginx project was retired and archived in March 2026. Its final chart, `4.15.1`, was tested through Kubernetes 1.35; GKE Regular currently defaults to 1.36.x. That is why Step 9 asks you to select a supported 1.35.x cluster version when available. GKE may later auto-upgrade the cluster, and this retired controller will not receive fixes. This is for a short learning deployment only. If the Console does not offer a 1.35.x version, stop before creating billable resources and review a supported ingress alternative/version plan. For production, use a maintained controller and update the design.

### Reserve the address in the Console

1. Open **VPC network → IP addresses → Reserve external static IP address**.
2. Name it `blog-ingress-ip`; choose **Regional**, region `asia-south1`, IPv4. Use the project's default network tier (normally Premium).
3. Reserve it and copy the actual IPv4 address shown and record it as `<INGRESS_IP>`. This is the address to enter into the GCP Helm values file. Keep the reserved address; do not release it until after cleanup.

### Put the address in the GCP Helm values file

Open `gcp/k8s/ingress-nginx-values.yaml` and replace `YOUR_INGRESS_IP` with the exact reserved IPv4 address you recorded as `<INGRESS_IP>` above. Do not include angle brackets. Save the file before running Helm. The chart will set this address on the LoadBalancer Service during creation.

### Install the controller

Run these commands from the repository root in PowerShell:

```powershell
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx --version 4.15.1 --namespace ingress-nginx --create-namespace --values gcp/k8s/ingress-nginx-values.yaml
kubectl get service ingress-nginx-controller -n ingress-nginx
```

Wait until `EXTERNAL-IP` shows the same address you reserved. If it stays `<pending>`, check GKE events, the address region, IP/forwarding-rule quota, and that the address is not already in use. Do not continue to DNS until the Service shows the reserved IP.

## 17. Use GoDaddy and Cloud DNS

This is the GCP equivalent of the AWS walkthrough's Route 53 plus GoDaddy setup. GoDaddy remains the **domain registrar** (where you bought the domain). Cloud DNS becomes the **authoritative DNS host** (the service that publishes the domain's DNS records). The GKE load balancer uses the reserved IP from Step 16.

### Part A: create a public Cloud DNS zone and records

1. In Google Cloud Console go to **Network Services → Cloud DNS → Create zone**.
2. Choose **Public zone**. Name it `blog-public-zone`; set DNS name to your domain, such as `example.com.` (include the final dot if the form requires it).
3. Leave DNSSEC off for this learning setup. Create the zone.
4. Open the zone details. Google creates NS and SOA records automatically. Open **Registrar setup** and copy all four Google name servers exactly as displayed. Do not edit the generated NS records.
5. Add two standard `A` records in this zone (not an Alias). The record name for the apex is blank or `@`, depending on the Console form. Both point to the reserved GKE IP from Step 16:

| DNS name | Type | IPv4 address |
|---|---|---|
| Apex/root (`<DOMAIN>`) | A | `<INGRESS_IP>` |
| `www.<DOMAIN>` | A | `<INGRESS_IP>` |

Set TTL to 300 seconds for the lab. The root and `www` records are both needed because the Kubernetes Ingress and certificate include both names. See Google's [Cloud DNS zone and record guide](https://docs.cloud.google.com/dns/docs/set-up-dns-records-domain-name).

### Part B: point your GoDaddy domain at Cloud DNS

Before changing nameservers, check whether the domain is used for email or other websites. Switching nameservers moves **all DNS hosting** to Cloud DNS. Records left only at GoDaddy (MX, SPF, DKIM, verification TXT, other subdomains) will stop resolving. Copy any records you need into Cloud DNS first.

1. Sign in to GoDaddy and open **Domain Portfolio**.
2. Select your domain, then open **DNS** or **Manage DNS**.
3. Find **Nameservers** and choose **Change**.
4. Choose the option to use your own nameservers (may say **I'll use my own nameservers** or **Enter my own nameservers**).
5. Enter all four Cloud DNS name servers copied in Part A. Remove a trailing period only if GoDaddy rejects it. Save/confirm.

The GoDaddy screen wording may change. Follow GoDaddy's [nameserver change help](https://www.godaddy.com/en/help/change-my-domain-nameservers-664) and Google's [name server update guide](https://docs.cloud.google.com/dns/docs/update-name-servers). Enter the Google servers in the domain's **Nameservers** delegation setting, not as ordinary GoDaddy `NS` records.

If DNSSEC was enabled at GoDaddy or the previous DNS host, disable or update the old DS/DNSSEC delegation before switching; a stale DS record can make the domain fail validation. Leave DNSSEC off for this lab unless you deliberately configure it at both ends.

### Part C: verify the delegation and address records

Nameserver changes can take time to propagate. Use the domain recorded in Step 2 (replace `<DOMAIN>` without angle brackets). In PowerShell, check the registered name servers and both hostnames:

```powershell
Resolve-DnsName -Type NS <DOMAIN> -Server 8.8.8.8
Resolve-DnsName <DOMAIN> -Server 8.8.8.8
Resolve-DnsName www.<DOMAIN> -Server 8.8.8.8
```

The NS answer should show the Cloud DNS name servers, and both A answers should match `<INGRESS_IP>`. Wait for DNS propagation before asking cert-manager for a certificate; Let's Encrypt must resolve both names publicly and reach ingress on HTTP port 80.

**Checkpoint:** GoDaddy delegates to all four Cloud DNS name servers; the apex and `www` resolve to the reserved GKE IP; any email or other DNS records you need are also present in Cloud DNS.

---

## 18. Enable HTTPS with cert-manager

Install cert-manager and wait for its components:

```powershell
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.21.3/cert-manager.yaml
kubectl wait --for=condition=Available deployment --all -n cert-manager --timeout=300s
```

Use the domain and email you recorded in Step 2. In `gcp/k8s/cluster-issuer.yaml`, replace `YOUR_EMAIL` with your real email. In `gcp/k8s/ingress.yaml`, replace every `YOUR_DOMAIN` with your domain only (for example `example.com`; no `https://`). Save both files. Check the root host is `<DOMAIN>` and the second host is `www.<DOMAIN>`, then apply:

```powershell
kubectl apply -f gcp/k8s/cluster-issuer.yaml
kubectl apply -f gcp/k8s/ingress.yaml
kubectl get certificate,challenge,order -n blog
```

Wait for `bharathonlineshopping-tls` to become Ready (this can take a few minutes):

```powershell
kubectl wait --for=condition=Ready certificate/bharathonlineshopping-tls -n blog --timeout=600s
kubectl get certificate -n blog
```

If the command times out, inspect `kubectl describe certificate bharathonlineshopping-tls -n blog` and `kubectl get challenges,orders -n blog`. Confirm public DNS points to the reserved IP, port 80 is reachable, the Ingress uses class `nginx`, and the issuer email is correct.

## 19. Verify the application

Open `https://<DOMAIN>` and test signup/login, create a post, and add a comment. Optionally query the posts API:

```powershell
Invoke-RestMethod https://<DOMAIN>/api/posts
kubectl get deployments,pods,services,ingress,hpa -n blog
kubectl describe ingress blog-ingress -n blog
```

Expected flow: Cloud DNS → external load balancer → NGINX paths → app services and pods → separate Cloud SQL databases over private IP.

## 20. Clean up

Delete resources when finished to stop ongoing charges. Back up data first if needed.

```powershell
kubectl delete -f gcp/k8s/ingress.yaml --ignore-not-found
helm uninstall ingress-nginx -n ingress-nginx
kubectl delete namespace ingress-nginx --ignore-not-found
kubectl delete namespace blog --ignore-not-found
kubectl delete -f gcp/k8s/cluster-issuer.yaml --ignore-not-found
kubectl delete -f https://github.com/cert-manager/cert-manager/releases/download/v1.21.3/cert-manager.yaml
```

Then in the Console remove, in order: if keeping the domain, first recreate its needed DNS records at the DNS provider you will keep and change GoDaddy nameservers there; only after delegation has moved, delete the Cloud DNS zone. Delete the Cloud SQL instance after export/backup; delete Artifact Registry repositories; delete the GKE cluster and wait for its load balancers to disappear; release the reserved `blog-ingress-ip`; delete Cloud NAT gateway and router; delete the Private Services Access connection and allocated range; finally delete the VPC/subnet after all attached resources are gone. Review Billing after deletion for retained IPs, disks, backups, and snapshots. Do not delete the whole project unless that is intentional.

## 21. Troubleshooting

| Symptom | Check first |
|---|---|
| Project/API unavailable | Correct project, billing, and required APIs enabled. |
| `kubectl` cannot connect | Control-plane authorized network includes current public IP; refresh credentials. |
| `ImagePullBackOff` | Correct full image path; push succeeded; node identity has Artifact Registry Reader. |
| Prisma Job failed | Private IP, PSA/VPC, Secret values/key names, DB names, grants; inspect Job logs. |
| `CrashLoopBackOff` | Pod logs/description, DB URL, JWT secret, health endpoint. |
| External IP pending | Wait; check events and external IP/forwarding-rule quota. |
| Domain unavailable | Registrar nameservers, A records, correct external IP, ports 80/443. |
| Certificate pending | Public DNS and HTTP port 80, Ingress class `nginx`, issuer email. |
| Private node egress fails | Private Google Access and Cloud NAT source ranges. |

## Official references

- [GKE Standard cluster architecture](https://cloud.google.com/kubernetes-engine/docs/concepts/standard-cluster-architecture)
- [GKE Regular channel release notes](https://docs.cloud.google.com/kubernetes-engine/docs/release-notes-regular)
- [GKE Service load balancers](https://cloud.google.com/kubernetes-engine/docs/concepts/service-load-balancer)
- [Private GKE clusters](https://cloud.google.com/kubernetes-engine/docs/concepts/private-cluster-concept)
- [Cloud NAT overview](https://cloud.google.com/nat/docs/overview)
- [Cloud SQL private IP](https://cloud.google.com/sql/docs/mysql/private-ip)
- [Artifact Registry Docker images](https://cloud.google.com/artifact-registry/docs/docker/store-docker-container-images)
- [Cloud DNS records](https://cloud.google.com/dns/docs/set-up-dns-records-domain-name)
- [GKE LoadBalancer static IP parameters](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/service-load-balancer-parameters)
- [cert-manager installation](https://cert-manager.io/docs/installation/)
- [cert-manager releases](https://github.com/cert-manager/cert-manager/releases)
- [ingress-nginx releases](https://github.com/kubernetes/ingress-nginx/releases)
- [ingress-nginx project notice](https://github.com/kubernetes/ingress-nginx)



















