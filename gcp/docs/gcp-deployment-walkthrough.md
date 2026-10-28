# MySocialSpace: GCP GKE deployment walkthrough

This beginner-friendly guide deploys the existing application to Google Cloud using the mirrored architecture in `gcp/architecture-diagram.html`. It is Google Cloud Console first. Use PowerShell and Docker Desktop for local steps and Kubernetes tasks the Console cannot perform.

- **Application:** frontend plus auth, post, and comment services; two replicas per application.
- **Cloud services:** Artifact Registry, VPC, Cloud NAT, GKE Standard, Cloud SQL for MySQL, Cloud DNS.
- **Traffic:** Browser → Cloud DNS → GKE external passthrough Network Load Balancer → NGINX Ingress → ClusterIP service → application pod → private Cloud SQL.
- **Example region:** `asia-south1` (Mumbai). Keep resources in compatible regions.
- **Cost:** this lab creates billable resources. A budget alert only sends alerts; it does not stop charges. Complete cleanup at the end.

> GCP manifests are under `gcp/k8s/`; application source and Dockerfiles remain shared in the repository root. Do not edit AWS files for this walkthrough.

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
16. [Install NGINX Ingress](#16-install-nginx-ingress)
17. [Configure the domain](#17-reserve-an-ip-and-point-your-domain)
18. [Enable HTTPS](#18-enable-https-with-cert-manager)
19. [Verify](#19-verify-the-application)
20. [Clean up](#20-clean-up)
21. [Troubleshooting](#21-troubleshooting)

## 1. Before starting

You need a Google account with project and billing permissions, a billing account, this repository cloned locally, and a domain you control for public DNS/HTTPS. Install Docker Desktop and switch it to **Linux containers**. Install Google Cloud CLI (`gcloud`), `kubectl`, and Helm on Windows. These tools are used for local Docker image publishing and Kubernetes operations.

```powershell
docker version
docker info --format '{{.OSType}}'
```

The second command should print `linux`; images below target `linux/amd64`.

## 2. Choose project values

Record your globally unique Google Cloud **Project ID** (not display name), region `asia-south1`, domain (without `https://`), email for Let's Encrypt, Cloud SQL private IP, SQL password, and your current public IP. Commands use `<PROJECT_ID>`, `<DOMAIN>`, `<EMAIL>`, `<SQL_PRIVATE_IP>`, and `<SQL_PASSWORD>` placeholders. Replace each placeholder before running commands. Do not commit passwords.

## 3. Prepare the Google Cloud project

In Google Cloud Console, select/create the project and link billing. Under **APIs & Services → Library**, enable Kubernetes Engine, Artifact Registry, Cloud SQL Admin, Compute Engine, Cloud DNS, Service Networking, and Cloud Resource Manager APIs. Under **Billing → Budgets & alerts**, create an alert at an amount you can afford. An alert does not cap spending.

**Checkpoint:** correct project selected and billing enabled.

## 4. Create the VPC and subnet in the Console

A VPC is the private network shared by GKE and Cloud SQL.

1. Open **VPC network → VPC networks → Create VPC network**. Name it `blog-vpc`, use custom subnet creation.
2. Create subnet `blog-subnet` in `asia-south1`, primary IPv4 range `10.10.0.0/20`.
3. Add secondary ranges `blog-pods` = `10.20.0.0/16` and `blog-services` = `10.30.0.0/20`.
4. Enable **Private Google Access** on the subnet so private nodes can reach Google APIs.
5. Create the network. Do not create broad internet firewall rules.

**Checkpoint:** VPC and subnet show the primary and secondary ranges, and Private Google Access is enabled.

## 5. Set up private access and Cloud NAT in the Console

Cloud SQL private IP requires Private Services Access. Cloud NAT provides outbound internet access to private nodes without giving each node a public IP.

**Private Services Access:** In **VPC network → VPC networks → blog-vpc → Private services access**, allocate a non-overlapping internal range named `blog-sql-range` (for example `10.40.0.0/16`) and create a private connection to `servicenetworking.googleapis.com`.

**Cloud NAT:** In **VPC network → Cloud NAT**, create router `blog-router` and gateway `blog-nat` in `asia-south1` on `blog-vpc`. Automatic NAT IP allocation is fine for this lab. Include all subnet ranges (primary and secondary) as NAT sources. Create it.

**Checkpoint:** PSA connection is established and Cloud NAT is attached to the VPC in the selected region.

## 6. Create Artifact Registry repositories in the Console

Artifact Registry stores the private container images. In **Artifact Registry → Repositories → Create repository**, create four **Docker**, **Standard**, regional repositories in `asia-south1`: `blog-frontend`, `blog-auth-service`, `blog-post-service`, and `blog-comment-service`.

**Checkpoint:** four repositories appear. They are empty until you push images.

## 7. Build and push images with Docker Desktop

The Console cannot build from your local source tree. Open PowerShell at the repository root. Sign in and configure Docker credentials:

```powershell
gcloud auth login
gcloud config set project <PROJECT_ID>
gcloud auth configure-docker asia-south1-docker.pkg.dev
```

Build and push each image (repository paths must match the Artifact Registry names):

```powershell
docker build --platform linux/amd64 -t asia-south1-docker.pkg.dev/<PROJECT_ID>/blog-auth-service/blog-auth-service:latest ./services/auth-service
docker push asia-south1-docker.pkg.dev/<PROJECT_ID>/blog-auth-service/blog-auth-service:latest
docker build --platform linux/amd64 -t asia-south1-docker.pkg.dev/<PROJECT_ID>/blog-post-service/blog-post-service:latest ./services/post-service
docker push asia-south1-docker.pkg.dev/<PROJECT_ID>/blog-post-service/blog-post-service:latest
docker build --platform linux/amd64 -t asia-south1-docker.pkg.dev/<PROJECT_ID>/blog-comment-service/blog-comment-service:latest ./services/comment-service
docker push asia-south1-docker.pkg.dev/<PROJECT_ID>/blog-comment-service/blog-comment-service:latest
docker build --platform linux/amd64 -t asia-south1-docker.pkg.dev/<PROJECT_ID>/blog-frontend/blog-frontend:latest ./frontend
docker push asia-south1-docker.pkg.dev/<PROJECT_ID>/blog-frontend/blog-frontend:latest
```

The frontend uses same-origin `/api/...` requests, so do not provide a separate API URL build argument. The manifests use `latest` for this lab; after rebuilding, push and restart the matching Deployment.

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

1. Open **Kubernetes Engine → Clusters → Create → GKE Standard**. Name `blog-gke`; location type **Regional**; region `asia-south1`; choose Regular release channel and supported default version.
2. Select `blog-vpc`, subnet `blog-subnet`, VPC-native traffic, Pod range `blog-pods`, Service range `blog-services`.
3. Enable private nodes. Keep an administrative control-plane endpoint and enable authorized networks; add your current public IP with `/32`. Never use `0.0.0.0/0` for this allowlist.
4. Create node pool `blog-workers`: machine `e2-medium`, three nodes total (one per zone), autoscaling off for this fixed-size lab. Use a default node service account and note its identity.
5. Ensure HTTP load balancing and metrics/HPA support are enabled. Create and wait for **Ready**.

Regional cluster management, VMs, disks, database, NAT, IPs, and load balancer can incur charges. Review current pricing before creation.

**Checkpoint:** Ready regional cluster with three private nodes.

## 10. Install local tools and connect

Install `gcloud`, `kubectl`, and Helm if missing. In **IAM & Admin → IAM**, grant the GKE node service account **Artifact Registry Reader** (`roles/artifactregistry.reader`); this allows nodes to pull images and is separate from your image push permission.

```powershell
gcloud container clusters get-credentials blog-gke --region asia-south1 --project <PROJECT_ID>
kubectl get nodes
```

**Checkpoint:** three nodes show `Ready`. If forbidden/unreachable, check your current IP is authorized and refresh credentials.

## 11. Set image names in the GCP manifests

In VS Code Find in Files, scope search to `gcp/k8s/` and replace `YOUR_PROJECT_ID` with your Project ID. Confirm image paths begin `asia-south1-docker.pkg.dev/<PROJECT_ID>/`. Do not edit root `k8s/`. Keep domain/email placeholders until their steps below.

## 12. Create the namespace and database Secret

A Kubernetes Secret stores connection strings without putting them in YAML. Use Cloud SQL's private IP. Run from the repo root in PowerShell; replace `<SQL_PRIVATE_IP>` before executing. Use the same password for all three databases.

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

This ephemeral utility pod checks the network route to MySQL (not the password):

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

The three backend HPAs keep at least two replicas and may scale to five on CPU; frontend stays at two.

```powershell
kubectl apply -f gcp/k8s/auth-service/
kubectl apply -f gcp/k8s/post-service/
kubectl apply -f gcp/k8s/comment-service/
kubectl apply -f gcp/k8s/frontend/
kubectl apply -f gcp/k8s/auth-service/hpa.yaml
kubectl apply -f gcp/k8s/post-service/hpa.yaml
kubectl apply -f gcp/k8s/comment-service/hpa.yaml
kubectl get deployments,pods,services,hpa -n blog
kubectl rollout status deployment/auth-service -n blog
kubectl rollout status deployment/post-service -n blog
kubectl rollout status deployment/comment-service -n blog
kubectl rollout status deployment/frontend -n blog
```

**Checkpoint:** four Deployments available, eight application pods Ready. For issues use `kubectl describe pod <POD_NAME> -n blog` and `kubectl logs <POD_NAME> -n blog`.

## 16. Install NGINX Ingress

This controller routes HTTP paths to ClusterIP services. Its LoadBalancer Service asks GKE for the external passthrough Network Load Balancer shown in the architecture.

**Lifecycle caveat:** the community ingress-nginx project was retired in March 2026. It is retained for this learning architecture, but is no longer a suitable choice for a new production system. This guide pins the final chart line, which may become unavailable upstream. For production, select a currently supported controller and update the design first.

```powershell
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx --version 4.14.2 --namespace ingress-nginx --create-namespace --values gcp/k8s/ingress-nginx-values.yaml
kubectl get service -n ingress-nginx
```

Wait for the controller Service external IP. Reserve a regional static IP in the Console (**VPC network → IP addresses**) for stable DNS, and configure the Service to use it according to current GKE instructions. If using the ephemeral address for a short practice run, record it; it can change if the load balancer is recreated.

## 17. Reserve an IP and point your domain

Create a public managed zone in **Network Services → Cloud DNS** for your domain. At the registrar, set the domain nameservers to those shown by Cloud DNS. Add A records for `@` and `www` pointing at the ingress external IP. Allow propagation, then check:

```powershell
Resolve-DnsName <DOMAIN>
Resolve-DnsName www.<DOMAIN>
```

Both must return the load balancer IP before requesting the certificate. Port 80 must reach NGINX for the HTTP challenge.

## 18. Enable HTTPS with cert-manager

Install cert-manager and wait for its components:

```powershell
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.21.2/cert-manager.yaml
kubectl wait --for=condition=Available deployment --all -n cert-manager --timeout=180s
```

In `gcp/k8s/cluster-issuer.yaml` replace `YOUR_EMAIL`. In `gcp/k8s/ingress.yaml` replace all `YOUR_DOMAIN` with your actual domain (no scheme). Apply:

```powershell
kubectl apply -f gcp/k8s/cluster-issuer.yaml
kubectl apply -f gcp/k8s/ingress.yaml
kubectl get certificate,challenge,order -n blog
```

Wait for `bharathonlineshopping-tls` to become Ready. If pending, inspect `kubectl describe certificate bharathonlineshopping-tls -n blog`. DNS, public port 80, ingress class `nginx`, and email must be correct.

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
kubectl delete -f https://github.com/cert-manager/cert-manager/releases/download/v1.21.2/cert-manager.yaml
```

Then in the Console remove, in order: Cloud DNS records/zone (and update registrar nameservers if needed); Cloud SQL instance (after export/backup); Artifact Registry repositories; GKE cluster; Cloud NAT gateway and router; Private Services Access connection and allocated range; finally VPC/subnet after all attached resources are gone. Review Billing after deletion for retained IPs, disks, backups, and snapshots. Do not delete the whole project unless that is intentional.

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
| Certificate pending | Public DNS and HTTP port 80, `nginx` class, issuer email. |
| Private node egress fails | Private Google Access and Cloud NAT source ranges. |

## Official references

- [GKE Standard cluster architecture](https://cloud.google.com/kubernetes-engine/docs/concepts/standard-cluster-architecture)
- [GKE Service load balancers](https://cloud.google.com/kubernetes-engine/docs/concepts/service-load-balancer)
- [Private GKE clusters](https://cloud.google.com/kubernetes-engine/docs/concepts/private-cluster-concept)
- [Cloud NAT overview](https://cloud.google.com/nat/docs/overview)
- [Cloud SQL private IP](https://cloud.google.com/sql/docs/mysql/private-ip)
- [Artifact Registry Docker images](https://cloud.google.com/artifact-registry/docs/docker/store-docker-container-images)
- [Cloud DNS records](https://cloud.google.com/dns/docs/set-up-dns-records-domain-name)
- [cert-manager installation](https://cert-manager.io/docs/installation/)
- [ingress-nginx project notice](https://github.com/kubernetes/ingress-nginx)
