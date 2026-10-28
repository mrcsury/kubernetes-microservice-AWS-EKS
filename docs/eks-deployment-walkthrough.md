# MySocialSpace: AWS EKS deployment walkthrough

A step-by-step script for deploying the MySocialSpace blog platform (three Node.js microservices and a React frontend) to Amazon EKS in the Mumbai region, with an RDS MySQL database and HTTPS on your own domain. Follow the steps in order, top to bottom. Every step ends with a **Checkpoint** that tells you what you should see before moving on.

- **Starting point:** you have a copy of this repository on your computer, and an AWS account.
- **End result:** the app runs on EKS at `https://<DOMAIN>`, with a valid Let's Encrypt certificate, and stores its data in a private RDS database.
- **Time:** 2 to 3 hours the first time. Most of it is waiting for AWS to create the cluster and the database.

> All commands in this guide are written for a **bash** terminal: Linux, macOS, or **Git Bash** on Windows (it is installed with Git for Windows). Windows PowerShell changes text that is piped between programs, which breaks the ECR login in Step 6. If you use PowerShell anyway, read the note in Step 6.

> This guide deploys by hand. The GitHub Actions workflow in `.github/workflows/deploy.yaml` is not covered here.

---

## Contents

1. [How the deployment works](#1-how-the-deployment-works)
2. [What you need before you start](#2-what-you-need-before-you-start)
3. [Write down your values](#3-write-down-your-values)
4. [Step 1: Check your tools and AWS sign-in](#4-step-1-check-your-tools-and-aws-sign-in)
5. [Step 2: Review the cluster configuration](#5-step-2-review-the-cluster-configuration)
6. [Step 3: Create the EKS cluster](#6-step-3-create-the-eks-cluster)
7. [Step 4: Create the ECR repositories](#7-step-4-create-the-ecr-repositories)
8. [Step 5: Point the manifests at your account](#8-step-5-point-the-manifests-at-your-account)
9. [Step 6: Build and push the images](#9-step-6-build-and-push-the-images)
10. [Step 7: Look up the cluster network](#10-step-7-look-up-the-cluster-network)
11. [Step 8: Create the RDS security group](#11-step-8-create-the-rds-security-group)
12. [Step 9: Create the RDS database](#12-step-9-create-the-rds-database)
13. [Step 10: Test the connection from the cluster](#13-step-10-test-the-connection-from-the-cluster)
14. [Step 11: Create the three databases](#14-step-11-create-the-three-databases)
15. [Step 12: Create the namespace and the secret](#15-step-12-create-the-namespace-and-the-secret)
16. [Step 13: Create the tables](#16-step-13-create-the-tables)
17. [Step 14: Deploy the services](#17-step-14-deploy-the-services)
18. [Step 15: Install ingress-nginx and cert-manager](#18-step-15-install-ingress-nginx-and-cert-manager)
19. [Step 16: Set your domain and apply the ingress](#19-step-16-set-your-domain-and-apply-the-ingress)
20. [Step 17: Point your domain at the load balancer](#20-step-17-point-your-domain-at-the-load-balancer)
21. [Step 18: Let the cluster reach its own domain](#21-step-18-let-the-cluster-reach-its-own-domain)
22. [Step 19: Check the application](#22-step-19-check-the-application)
23. [Summary of everything you created](#23-summary-of-everything-you-created)
24. [Troubleshooting](#24-troubleshooting)
25. [Clean up](#25-clean-up)

---

## 1. How the deployment works

```
Browser ──https──▶ Route 53 ──▶ Network Load Balancer ──▶ ingress-nginx ──┬──▶ frontend        (React, port 80)
                   (DNS)        (created by Kubernetes)    (in the cluster) ├──▶ auth-service    (port 3001)
                                                                            ├──▶ post-service    (port 3002)
                                                                            └──▶ comment-service (port 3003)
                                                                                        │
                                                                                        ▼
                                                                         RDS MySQL (private, same VPC)
                                                                         auth_db · posts_db · comments_db
```

What happens when someone opens the site:

1. Route 53 answers the DNS lookup for `<DOMAIN>` with the address of the Network Load Balancer.
2. The load balancer passes the request to the **ingress-nginx** controller inside the cluster.
3. ingress-nginx looks at the path and sends the request on:
   - `/api/auth/...` to auth-service
   - `/api/posts/...` to post-service
   - `/api/comments/...` to comment-service
   - everything else to the frontend
4. Each backend service reads and writes its own database on the RDS instance.
5. post-service and comment-service call auth-service inside the cluster to look up author names.

The frontend calls the API with relative addresses such as `/api/posts`, so it works on any domain without being rebuilt.

The pieces you will create:

| Piece | What it does |
|---|---|
| EKS cluster `blog-cluster` | Runs the containers. 3 worker nodes, all in `ap-south-1a`. |
| ECR repositories (4) | Store the container images the nodes download. |
| RDS instance `blog-platform-db` | MySQL 8.4, private, reachable only from the cluster. |
| ingress-nginx | Creates the AWS load balancer and routes requests by path. |
| cert-manager | Gets and renews the HTTPS certificate from Let's Encrypt. |
| Route 53 hosted zone | Holds the DNS records for your domain. |

There are **two security groups** that matter. Students often mix them up, so it helps to name them early:

| Security group | Attached to | Rule that connects them |
|---|---|---|
| EKS cluster security group (`eks-cluster-sg-blog-cluster-...`) | Every worker node | Created by EKS. You only look it up. |
| `blog-rds-sg` | The RDS instance | Allows MySQL (port 3306) **only** from the EKS cluster security group. |

---

## 2. What you need before you start

- [ ] An AWS account and an IAM user that can create EKS, EC2, VPC, RDS, ECR, IAM and Route 53 resources (an administrator user is simplest for a lab).
- [ ] An access key for that user. You type it into `aws configure` in Step 1.
- [ ] These tools installed on your computer:

  | Tool | Minimum version | Check with |
  |---|---|---|
  | AWS CLI | v2 | `aws --version` |
  | eksctl | 0.231.0 | `eksctl version` |
  | kubectl | within one minor version of the cluster (1.34 to 1.36) | `kubectl version --client` |
  | Docker **or** Podman | any recent version | `docker version` or `podman version` |

- [ ] If you use Podman, a Podman machine that is running (`podman machine list` shows **Currently running**).
- [ ] A domain name you own, and access to its settings at the registrar (this guide uses GoDaddy as the example).
- [ ] A working email address for Let's Encrypt certificate-expiry notices.

> **Podman users:** every `docker` command in this guide works the same with `podman` in its place.

---

## 3. Write down your values

Several steps use values that differ for every person. Write yours down now. Wherever this guide shows a placeholder in angle brackets, type your own value **without** the angle brackets.

| Placeholder | What it is | Example |
|---|---|---|
| `<ACCOUNT_ID>` | Your 12-digit AWS account number. Step 1 shows you how to find it. | `769093516181` |
| `<DOMAIN>` | Your domain name, without `www` and without `https://`. | `bharathonlineshopping.com` |
| `<EMAIL>` | A real mailbox for Let's Encrypt notices. | `admin@bharathonlineshopping.com` |
| `<DB_PASSWORD>` | The RDS admin password. You generate it in Step 9. | (32 random letters and numbers) |

Values you will **look up** along the way (write them down when you get them):

| Placeholder | Found in |
|---|---|
| `<VPC_ID>` | Step 7 |
| `<CLUSTER_SG>` | Step 7 |
| `<PRIVATE_SUBNET_1A>`, `<PRIVATE_SUBNET_1B>` | Step 7 |
| `<RDS_SG>` | Step 8 |
| `<RDS_ENDPOINT>` | Step 9 |
| `<LB_DNS>` | Step 15 |

Names used in this guide. Keep them exactly as written, because later steps refer to them:

| Resource | Name |
|---|---|
| Region | `ap-south-1` (Mumbai) |
| EKS cluster | `blog-cluster` |
| Node group | `blog-workers` |
| ECR repositories | `blog-auth-service`, `blog-post-service`, `blog-comment-service`, `blog-frontend` |
| RDS instance | `blog-platform-db` |
| RDS subnet group | `blog-db-subnets` |
| RDS security group | `blog-rds-sg` |
| Kubernetes namespace | `blog` |
| Kubernetes secret | `blog-secrets` |
| Certificate issuer | `letsencrypt-prod` |

---

## 4. Step 1: Check your tools and AWS sign-in

1. Open a terminal in the top folder of this repository.
2. Sign the AWS CLI in to your account:

   ```bash
   aws configure
   ```

   Enter your access key ID, secret access key, region `ap-south-1`, and output format `json`.

3. Confirm which account you are signed in to:

   ```bash
   aws sts get-caller-identity --query Account --output text
   ```

   The 12-digit number it prints is your `<ACCOUNT_ID>`. Write it down.

4. Check which EKS versions AWS offers in Mumbai:

   ```bash
   aws eks describe-cluster-versions --region ap-south-1 \
     --query "clusterVersions[0:3].[clusterVersion,versionStatus]" --output table
   ```

**Checkpoint:** `get-caller-identity` prints your account number, and the version table lists several versions with status `STANDARD_SUPPORT`.

---

## 5. Step 2: Review the cluster configuration

The cluster is described in `eks-cluster.yaml`. Open it and check these settings. You do not need to change anything unless you want a different region.

```yaml
metadata:
  name: blog-cluster
  region: ap-south-1
  version: "1.35"

availabilityZones:
  - ap-south-1a
  - ap-south-1b

managedNodeGroups:
  - name: blog-workers
    availabilityZones:
      - ap-south-1a
    instanceType: t3.medium
    desiredCapacity: 3
    amiFamily: AmazonLinux2023
```

Why these choices:

- **Version `1.35`.** AWS may offer newer versions (1.36 or 1.37) than eksctl supports. eksctl 0.231.0 accepts at most 1.35. If you pick a newer one, `eksctl create cluster` refuses the file. You can upgrade the cluster later, once eksctl supports it.
- **Two availability zones for the cluster, one for the nodes.** EKS will not create a cluster unless it has subnets in at least two zones. The worker nodes still all run in `ap-south-1a`.
- **Amazon Linux 2023.** eksctl does not allow Amazon Linux 2 on Kubernetes 1.33 or later.

**Checkpoint:** the file shows region `ap-south-1`, version `"1.35"` and `amiFamily: AmazonLinux2023`.

---

## 6. Step 3: Create the EKS cluster

1. Create the cluster:

   ```bash
   eksctl create cluster -f eks-cluster.yaml
   ```

   This takes 15 to 20 minutes. eksctl creates a new VPC with public and private subnets in both zones, the EKS control plane, the 3 worker nodes, and the add-ons. It also adds `metrics-server` on its own, which the autoscalers need. When it finishes it sets up `kubectl` for you.

2. Check the nodes and their zone:

   ```bash
   kubectl get nodes -L topology.kubernetes.io/zone
   ```

**Checkpoint:** the last line of the eksctl output says `EKS cluster "blog-cluster" in "ap-south-1" region is ready`, and `kubectl get nodes` lists 3 nodes, all `Ready`, all in `ap-south-1a`.

> From this moment AWS bills you for the cluster and the nodes. See [Clean up](#25-clean-up) when you are done.

---

## 7. Step 4: Create the ECR repositories

The cluster nodes download the app images from these repositories.

```bash
for r in blog-auth-service blog-post-service blog-comment-service blog-frontend; do
  aws ecr create-repository --repository-name $r --region ap-south-1 \
    --image-scanning-configuration scanOnPush=true \
    --query "repository.repositoryUri" --output text
done
```

`scanOnPush=true` makes ECR scan each image for known security problems when it is pushed.

**Checkpoint:** four lines are printed, each starting with `<ACCOUNT_ID>.dkr.ecr.ap-south-1.amazonaws.com/blog-`.

---

## 8. Step 5: Point the manifests at your account

The deployment files name the exact image to run, including an account number and region. Make sure they use **your** account and `ap-south-1`.

1. Look at the current image lines:

   ```bash
   grep -n "image:" k8s/*/deployment.yaml frontend/deployment.yaml
   ```

2. If the account number is not yours, replace it in all four files. Replace `<OLD_ACCOUNT_ID>` with the number that is in the files now:

   ```bash
   sed -i 's/<OLD_ACCOUNT_ID>/<ACCOUNT_ID>/g' k8s/*/deployment.yaml frontend/deployment.yaml
   ```

3. If the region in the image lines is not `ap-south-1`, fix it the same way:

   ```bash
   sed -i 's/\.dkr\.ecr\.[a-z0-9-]*\./.dkr.ecr.ap-south-1./' k8s/*/deployment.yaml frontend/deployment.yaml
   ```

> **macOS:** use `sed -i ''` instead of `sed -i`.

**Checkpoint:** all four image lines read `<ACCOUNT_ID>.dkr.ecr.ap-south-1.amazonaws.com/blog-<name>:latest`.

---

## 9. Step 6: Build and push the images

1. Sign Docker in to ECR:

   ```bash
   aws ecr get-login-password --region ap-south-1 \
     | docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.ap-south-1.amazonaws.com
   ```

   > **Windows PowerShell:** PowerShell 5.1 changes the token while piping it, and the login fails with `Your Authorization Token is invalid`. Run the same pipe inside `cmd` instead:
   > ```powershell
   > cmd /c "aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.ap-south-1.amazonaws.com"
   > ```

2. Build and push all four images:

   ```bash
   REG=<ACCOUNT_ID>.dkr.ecr.ap-south-1.amazonaws.com
   docker build --platform linux/amd64 -t $REG/blog-auth-service:latest    ./services/auth-service
   docker build --platform linux/amd64 -t $REG/blog-post-service:latest    ./services/post-service
   docker build --platform linux/amd64 -t $REG/blog-comment-service:latest ./services/comment-service
   docker build --platform linux/amd64 -t $REG/blog-frontend:latest        ./frontend
   for i in auth-service post-service comment-service frontend; do docker push $REG/blog-$i:latest; done
   ```

   Why these choices:

   - `--platform linux/amd64`: the `t3.medium` nodes use Intel/AMD processors. Without this, an image built on an Apple Silicon Mac would not start on them.
   - The frontend is built **without** `--build-arg VITE_API_URL`. It then calls the API with relative paths like `/api/posts`, which work on any domain.

3. Check that ECR has all four:

   ```bash
   for r in blog-auth-service blog-post-service blog-comment-service blog-frontend; do
     aws ecr describe-images --repository-name $r --region ap-south-1 \
       --query "imageDetails[0].[repositoryName,join(',',imageTags)]" --output text
   done
   ```

**Checkpoint:** the login prints `Login Succeeded`, and the last command prints each repository name followed by `latest`.

---

## 10. Step 7: Look up the cluster network

The database must be created inside the cluster's VPC. Collect the IDs you need.

```bash
aws eks describe-cluster --name blog-cluster --region ap-south-1 \
  --query "cluster.resourcesVpcConfig.[vpcId,clusterSecurityGroupId]" --output text
```

This prints two values: `<VPC_ID>` and `<CLUSTER_SG>`. Write both down.

```bash
aws ec2 describe-subnets --region ap-south-1 \
  --filters Name=vpc-id,Values=<VPC_ID> \
  --query "Subnets[].[SubnetId,AvailabilityZone,MapPublicIpOnLaunch]" --output table
```

The subnets with `False` in the last column are the **private** subnets. Write down the private one in `ap-south-1a` as `<PRIVATE_SUBNET_1A>` and the private one in `ap-south-1b` as `<PRIVATE_SUBNET_1B>`.

Confirm that the worker nodes use the cluster security group:

```bash
aws ec2 describe-instances --region ap-south-1 \
  --filters "Name=tag:eks:cluster-name,Values=blog-cluster" "Name=instance-state-name,Values=running" \
  --query "Reservations[].Instances[].[InstanceId,join(',',SecurityGroups[].GroupId)]" --output text
```

**Checkpoint:** you have `<VPC_ID>`, `<CLUSTER_SG>` and two private subnet IDs written down, and every node in the last output shows `<CLUSTER_SG>`.

---

## 11. Step 8: Create the RDS security group

This security group lets the cluster talk to the database, and nothing else.

1. Create the group:

   ```bash
   aws ec2 create-security-group --group-name blog-rds-sg \
     --description "MySQL access for blog-cluster" \
     --vpc-id <VPC_ID> --region ap-south-1 --query GroupId --output text
   ```

   Write down the ID it prints as `<RDS_SG>`.

2. **EKS to RDS:** allow MySQL in from the cluster security group:

   ```bash
   aws ec2 authorize-security-group-ingress --group-id <RDS_SG> --region ap-south-1 \
     --ip-permissions "IpProtocol=tcp,FromPort=3306,ToPort=3306,UserIdGroupPairs=[{GroupId=<CLUSTER_SG>,Description='MySQL from EKS nodes'}]"
   ```

3. **RDS to EKS:** replace the default "allow all outbound" rule so the database can only send traffic to the cluster:

   ```bash
   aws ec2 revoke-security-group-egress --group-id <RDS_SG> --region ap-south-1 \
     --ip-permissions "IpProtocol=-1,IpRanges=[{CidrIp=0.0.0.0/0}]"

   aws ec2 authorize-security-group-egress --group-id <RDS_SG> --region ap-south-1 \
     --ip-permissions "IpProtocol=tcp,FromPort=0,ToPort=65535,UserIdGroupPairs=[{GroupId=<CLUSTER_SG>,Description='Return traffic to EKS nodes'}]"
   ```

4. **Cluster side:** add an explicit outbound rule from the cluster security group to the database:

   ```bash
   aws ec2 authorize-security-group-egress --group-id <CLUSTER_SG> --region ap-south-1 \
     --ip-permissions "IpProtocol=tcp,FromPort=3306,ToPort=3306,UserIdGroupPairs=[{GroupId=<RDS_SG>,Description='MySQL to blog RDS'}]"
   ```

What the rules mean:

| Rule | On | Meaning |
|---|---|---|
| Inbound TCP 3306 from `<CLUSTER_SG>` | `blog-rds-sg` | Only the worker nodes can open a MySQL connection. |
| Outbound TCP to `<CLUSTER_SG>` | `blog-rds-sg` | The database can only send traffic back to the nodes. |
| Outbound TCP 3306 to `<RDS_SG>` | Cluster SG | Makes the link visible on the cluster side. The cluster group already allows all outbound traffic, so this changes nothing functionally. |

Security groups remember connections. Replies to a connection are always allowed, so no new **inbound** rule is needed on the nodes.

**Checkpoint:** each `authorize` and `revoke` command prints `"Return": true`.

---

## 12. Step 9: Create the RDS database

1. Create a subnet group from the two private subnets. RDS needs subnets in two zones, even for a single instance:

   ```bash
   aws rds create-db-subnet-group --db-subnet-group-name blog-db-subnets \
     --db-subnet-group-description "Private subnets of blog-cluster VPC" \
     --subnet-ids <PRIVATE_SUBNET_1A> <PRIVATE_SUBNET_1B> --region ap-south-1
   ```

2. Generate a strong password. Letters and numbers only, so it is safe inside a connection string:

   ```bash
   openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32; echo
   ```

   Save the output in a password manager. This is your `<DB_PASSWORD>`.

3. Check the newest MySQL 8.4 version:

   ```bash
   aws rds describe-db-engine-versions --engine mysql --region ap-south-1 \
     --query "DBEngineVersions[?starts_with(EngineVersion,'8.4')].EngineVersion | [-1]" --output text
   ```

4. Create the instance. Use the version from the previous command:

   ```bash
   aws rds create-db-instance --region ap-south-1 \
     --db-instance-identifier blog-platform-db \
     --engine mysql --engine-version 8.4.11 \
     --db-instance-class db.t3.micro \
     --allocated-storage 20 --storage-type gp3 --storage-encrypted \
     --master-username admin --master-user-password '<DB_PASSWORD>' \
     --db-subnet-group-name blog-db-subnets \
     --vpc-security-group-ids <RDS_SG> \
     --availability-zone ap-south-1a \
     --no-publicly-accessible --no-multi-az \
     --backup-retention-period 1
   ```

   Why these choices:

   - `--availability-zone ap-south-1a`: the same zone as the nodes. Traffic between zones costs extra.
   - `--no-publicly-accessible`: the database gets no internet address. Only the cluster can reach it.
   - `--storage-encrypted`: data on disk is encrypted at no extra cost.

5. Wait until it is ready (5 to 10 minutes), then get its address:

   ```bash
   aws rds wait db-instance-available --db-instance-identifier blog-platform-db --region ap-south-1
   aws rds describe-db-instances --db-instance-identifier blog-platform-db --region ap-south-1 \
     --query "DBInstances[0].[DBInstanceStatus,Endpoint.Address]" --output text
   ```

   Write down the address as `<RDS_ENDPOINT>`.

**Checkpoint:** the last command prints `available` followed by an address ending in `.ap-south-1.rds.amazonaws.com`.

---

## 13. Step 10: Test the connection from the cluster

The database has no public address, so you cannot reach it from your computer. Test it from a short-lived pod inside the cluster:

```bash
kubectl run rds-conn-test --rm -i --restart=Never --image=busybox:1.36 --command -- \
  sh -c "nc -zv -w 5 <RDS_ENDPOINT> 3306 && echo REACHABLE"
```

**Checkpoint:** the output shows `open` and `REACHABLE`. This proves the security group rules from Step 8 work. If it hangs and times out, see [Troubleshooting](#24-troubleshooting).

---

## 14. Step 11: Create the three databases

Each service has its own database. `init-db.sql` creates them:

```sql
CREATE DATABASE IF NOT EXISTS auth_db;
CREATE DATABASE IF NOT EXISTS posts_db;
CREATE DATABASE IF NOT EXISTS comments_db;
```

Run it from a temporary MySQL pod:

```bash
{ cat init-db.sql; echo; echo "SHOW DATABASES;"; } \
  | kubectl run mysql-init --rm -i --restart=Never --image=mysql:8.4 \
      --env="MYSQL_PWD=<DB_PASSWORD>" --command -- mysql -h <RDS_ENDPOINT> -u admin
```

**Checkpoint:** the list of databases includes `auth_db`, `posts_db` and `comments_db`.

---

## 15. Step 12: Create the namespace and the secret

1. Create the `blog` namespace:

   ```bash
   kubectl apply -f k8s/namespace.yaml
   ```

2. Open `k8s/secrets.yaml` and fill in your values:

   ```yaml
   stringData:
     jwt-secret: "<A_LONG_RANDOM_STRING>"
     db-auth-url: "mysql://admin:<DB_PASSWORD>@<RDS_ENDPOINT>:3306/auth_db"
     db-posts-url: "mysql://admin:<DB_PASSWORD>@<RDS_ENDPOINT>:3306/posts_db"
     db-comments-url: "mysql://admin:<DB_PASSWORD>@<RDS_ENDPOINT>:3306/comments_db"
   ```

   - Generate the JWT secret the same way as the password: `openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 64`.
   - Changing `jwt-secret` later signs every user out, so set a real value now.

3. Stop Git from picking up your edited file, so the password is never committed:

   ```bash
   git update-index --skip-worktree k8s/secrets.yaml
   ```

4. Create the secret in the cluster:

   ```bash
   kubectl apply -f k8s/secrets.yaml
   ```

5. Check it, without printing the password:

   ```bash
   kubectl get secret blog-secrets -n blog -o jsonpath='{.data.db-auth-url}' | base64 -d \
     | sed 's/admin:[^@]*@/admin:****@/'; echo
   ```

**Checkpoint:** `kubectl get secret blog-secrets -n blog` shows `DATA 4`, and the last command prints your RDS address with the password hidden.

---

## 16. Step 13: Create the tables

Each service defines its tables with Prisma. `prisma db push` creates them. Run it once per service as a Kubernetes Job. The Job reads the connection string from `blog-secrets`, so the password never appears on a command line.

```bash
REG=<ACCOUNT_ID>.dkr.ecr.ap-south-1.amazonaws.com
for s in auth:auth-service:db-auth-url posts:post-service:db-posts-url comments:comment-service:db-comments-url; do
IFS=: read short svc key <<< "$s"
cat <<EOF
---
apiVersion: batch/v1
kind: Job
metadata:
  name: prisma-push-$short
  namespace: blog
spec:
  backoffLimit: 1
  ttlSecondsAfterFinished: 600
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: prisma
          image: $REG/blog-$svc:latest
          command: ["sh", "-c", "npx prisma db push --skip-generate"]
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: blog-secrets
                  key: $key
EOF
done | kubectl apply -f -

kubectl wait --for=condition=complete job/prisma-push-auth job/prisma-push-posts job/prisma-push-comments -n blog --timeout=300s
for j in auth posts comments; do kubectl logs job/prisma-push-$j -n blog | grep -E "Datasource|sync"; done
```

The Jobs delete themselves 10 minutes after they finish.

> The deployment files also run `prisma db push` each time a pod starts. Running it here first means a database problem shows up now, in one clear log, instead of as pods that keep restarting in the next step.

This step also proves three things at once: the nodes can pull from ECR, the secret is correct, and the password works.

**Checkpoint:** all three Jobs report `condition met`, and each log says `Your database is now in sync with your Prisma schema`.

---

## 17. Step 14: Deploy the services

1. Apply the deployments, services and autoscalers:

   ```bash
   kubectl apply -f k8s/auth-service -f k8s/post-service -f k8s/comment-service \
     -f frontend/deployment.yaml -f frontend/service.yaml
   ```

2. Wait for them to start:

   ```bash
   for d in auth-service post-service comment-service frontend; do
     kubectl rollout status deployment/$d -n blog --timeout=180s
   done
   kubectl get pods,svc,hpa -n blog
   ```

3. Call the API from inside the cluster:

   ```bash
   kubectl run api-check --rm -i --restart=Never -n blog --image=curlimages/curl:8.10.1 --command -- \
     curl -s http://post-service:3002/api/posts
   ```

What was created:

| Service | Pods | Port | Health check |
|---|---|---|---|
| auth-service | 2 (autoscales to 5) | 3001 | `/health` |
| post-service | 2 (autoscales to 5) | 3002 | `/health` |
| comment-service | 2 (autoscales to 5) | 3003 | `/health` |
| frontend | 2 | 80 | none |

The autoscalers add pods when average CPU goes above 70%. For the first minute their target shows `<unknown>` while metrics-server collects data. That is normal.

**Checkpoint:** all 8 pods are `Running` and `1/1` ready, and the API call returns `{"posts":[],"pagination":...}`.

The app now runs, but only inside the cluster. The next steps open it to the internet.

---

## 18. Step 15: Install ingress-nginx and cert-manager

1. Install the ingress-nginx controller. The AWS version of its manifest creates a Network Load Balancer:

   ```bash
   kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.15.1/deploy/static/provider/aws/deploy.yaml
   ```

2. Install cert-manager:

   ```bash
   kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.21.2/cert-manager.yaml
   ```

3. Wait for both:

   ```bash
   kubectl rollout status deployment/ingress-nginx-controller -n ingress-nginx --timeout=240s
   for d in cert-manager cert-manager-webhook cert-manager-cainjector; do
     kubectl rollout status deployment/$d -n cert-manager --timeout=240s
   done
   ```

4. Get the load balancer's address:

   ```bash
   kubectl get svc ingress-nginx-controller -n ingress-nginx \
     -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'; echo
   ```

   Write it down as `<LB_DNS>`. It ends in `.elb.ap-south-1.amazonaws.com`.

> **ingress-nginx is retired.** The Kubernetes project stopped maintaining it in March 2026, so it gets no more security fixes. It works for this lab. For anything long-lived, use the AWS Load Balancer Controller or a Gateway API implementation instead.

**Checkpoint:** all four deployments report `successfully rolled out`, and you have `<LB_DNS>` written down.

---

## 19. Step 16: Set your domain and apply the ingress

1. Put your domain into the ingress and your email into the certificate issuer. Replace `<OLD_DOMAIN>` with the domain that is in the files now (check with `grep -n host: k8s/ingress.yaml`):

   ```bash
   sed -i 's/<OLD_DOMAIN>/<DOMAIN>/g' k8s/ingress.yaml
   ```

   Then open `k8s/cluster-issuer.yaml` and set `email:` to `<EMAIL>`.

2. Check the files:

   ```bash
   grep -nE "host|secretName|- " k8s/ingress.yaml | head -8
   grep -n email k8s/cluster-issuer.yaml
   ```

   The ingress must list both `<DOMAIN>` and `www.<DOMAIN>`.

3. Apply both:

   ```bash
   kubectl apply -f k8s/cluster-issuer.yaml
   kubectl apply -f k8s/ingress.yaml
   kubectl get clusterissuer letsencrypt-prod
   kubectl get certificate -n blog
   ```

4. Test the load balancer before DNS exists, by sending your domain name in the request:

   ```bash
   curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" -H "Host: <DOMAIN>" http://<LB_DNS>/
   ```

   A new load balancer can take 2 to 3 minutes before it answers. If you get `000`, wait and try again.

**Checkpoint:** the issuer shows `READY True`. The certificate shows `READY False`, which is expected until DNS is set up. The curl test prints `308 https://<DOMAIN>/`: the ingress is working and redirects to HTTPS.

---

## 20. Step 17: Point your domain at the load balancer

You move your domain's DNS to Route 53, then add two records that point at the load balancer.

### Part A: Create the hosted zone

1. In the AWS Console open **Route 53 > Hosted zones > Create hosted zone**.
2. **Domain name:** `<DOMAIN>`
3. **Type:** Public hosted zone.
4. Choose **Create hosted zone**.
5. Open the zone. The **NS** record lists four name servers, such as `ns-1355.awsdns-41.org`. Copy all four.

### Part B: Use the Route 53 name servers at GoDaddy

1. Sign in to GoDaddy and open your domain's **DNS** settings.
2. Open **Nameservers** and choose **Change nameservers**.
3. Choose **I'll use my own nameservers**.
4. Enter the four Route 53 name servers, without the dot at the end.
5. Save.

### Part C: Add the alias records

Create **two** records in the Route 53 zone. Both are needed: the certificate covers `<DOMAIN>` and `www.<DOMAIN>`, and Let's Encrypt checks each one.

For each record:

1. Choose **Create record**.
2. **Record name:** leave empty for the first record. Type `www` for the second.
3. **Record type:** A.
4. Turn on **Alias**.
5. **Route traffic to:** Alias to Network Load Balancer, region Asia Pacific (Mumbai), then select the load balancer that matches `<LB_DNS>`.
6. Choose **Create records**.

| Record name | Type | Alias target |
|---|---|---|
| `<DOMAIN>` | A (alias) | the Network Load Balancer |
| `www.<DOMAIN>` | A (alias) | the Network Load Balancer |

### Part D: Check DNS

```bash
nslookup -type=NS <DOMAIN> 8.8.8.8
nslookup <DOMAIN> 8.8.8.8
nslookup www.<DOMAIN> 8.8.8.8
```

Name server changes can take from a few minutes up to 48 hours to spread, though it is usually under an hour.

**Checkpoint:** the NS lookup returns the four `awsdns` name servers, and both names resolve to the same IP addresses as `nslookup <LB_DNS> 8.8.8.8`.

---

## 21. Step 18: Let the cluster reach its own domain

Look at the certificate now:

```bash
kubectl get certificate,challenge -n blog
kubectl describe challenge -n blog | grep -E "Domain:|Reason:"
```

The certificate most likely stays `READY False`, and the challenge reason says `failed to perform self check GET request ... context deadline exceeded`.

**Why this happens.** Before cert-manager asks Let's Encrypt for a certificate, it checks the challenge URL itself, from inside the cluster. That request goes from a pod, out to `<DOMAIN>`, to the Network Load Balancer, and back into the cluster. The load balancer keeps the pod's private IP as the source address. The node that receives the request then replies straight to the pod, skipping the load balancer, and the connection is dropped. Visitors on the internet are not affected; only requests from inside the cluster to its own domain fail.

**The fix.** Make `<DOMAIN>` and `www.<DOMAIN>` resolve to the ingress controller's internal address when they are looked up from inside the cluster. You add this to CoreDNS, the cluster's DNS server, through the EKS add-on settings so that add-on updates keep it.

1. Create a file named `coredns-config.yaml` (outside the repository is fine):

   ```yaml
   corefile: |
     .:53 {
         errors
         health {
             lameduck 5s
           }
         ready
         rewrite name exact <DOMAIN> ingress-nginx-controller.ingress-nginx.svc.cluster.local answer auto
         rewrite name exact www.<DOMAIN> ingress-nginx-controller.ingress-nginx.svc.cluster.local answer auto
         kubernetes cluster.local in-addr.arpa ip6.arpa {
           pods insecure
           fallthrough in-addr.arpa ip6.arpa
         }
         prometheus :9153
         forward . /etc/resolv.conf
         cache 30
         loop
         reload
         loadbalance
     }
   ```

   The only lines that differ from the default are the two `rewrite` lines.

2. Apply it to the CoreDNS add-on:

   ```bash
   aws eks update-addon --cluster-name blog-cluster --addon-name coredns --region ap-south-1 \
     --resolve-conflicts OVERWRITE --configuration-values file://coredns-config.yaml
   aws eks wait addon-active --cluster-name blog-cluster --addon-name coredns --region ap-south-1
   kubectl get configmap coredns -n kube-system -o jsonpath='{.data.Corefile}' | grep rewrite
   ```

3. Wait for the certificate. cert-manager retries on its own:

   ```bash
   kubectl wait --for=condition=Ready certificate/<CERT_NAME> -n blog --timeout=300s
   ```

   `<CERT_NAME>` is the `secretName` in `k8s/ingress.yaml`, for example `bharathonlineshopping-tls`.

**Checkpoint:** the grep shows both `rewrite` lines, and the certificate reports `condition met` within a few minutes.

> If you add more domains to the ingress later, add a `rewrite` line for each of them as well.

---

## 22. Step 19: Check the application

1. Check HTTPS from your computer:

   ```bash
   for u in https://<DOMAIN>/ https://www.<DOMAIN>/ https://<DOMAIN>/api/posts; do
     curl -s -o /dev/null -w "$u -> %{http_code}\n" $u
   done
   ```

2. Look at the certificate:

   ```bash
   echo | openssl s_client -connect <DOMAIN>:443 -servername <DOMAIN> 2>/dev/null \
     | openssl x509 -noout -issuer -enddate -ext subjectAltName
   ```

3. Open `https://<DOMAIN>` in a browser. Register a user, write a post, and add a comment to it.

**Checkpoint:** all three URLs return `200`. The certificate issuer is Let's Encrypt and it lists both `<DOMAIN>` and `www.<DOMAIN>`. In the browser the padlock shows, and your post and comment appear.

cert-manager renews the certificate automatically about 30 days before it expires.

---

## 23. Summary of everything you created

| Where | Resource | Name |
|---|---|---|
| EKS | Cluster | `blog-cluster` (Kubernetes 1.35) |
| EKS | Managed node group | `blog-workers`: 3 × t3.medium, Amazon Linux 2023, `ap-south-1a` |
| EKS | Add-ons | vpc-cni, coredns (with 2 rewrite lines), kube-proxy, metrics-server |
| VPC | Network (created by eksctl) | VPC, public and private subnets in 1a and 1b, NAT gateway |
| CloudWatch | Log group | `/aws/eks/blog-cluster/cluster` |
| ECR | Repositories | `blog-auth-service`, `blog-post-service`, `blog-comment-service`, `blog-frontend` |
| EC2 | Security group | `blog-rds-sg`, plus one outbound rule on the cluster security group |
| RDS | Subnet group | `blog-db-subnets` |
| RDS | Instance | `blog-platform-db`: MySQL 8.4, db.t3.micro, private |
| MySQL | Databases | `auth_db`, `posts_db`, `comments_db` |
| Kubernetes | Namespace and secret | `blog`, `blog-secrets` |
| Kubernetes | App | 4 deployments, 4 services, 3 autoscalers, 1 ingress |
| Kubernetes | Platform | ingress-nginx (creates a Network Load Balancer), cert-manager, issuer `letsencrypt-prod` |
| Route 53 | Hosted zone and records | `<DOMAIN>` zone, A alias records for `<DOMAIN>` and `www.<DOMAIN>` |
| GoDaddy | Name servers | the four Route 53 name servers |

---

## 24. Troubleshooting

### Cluster creation

| What you see | Cause | Fix |
|---|---|---|
| eksctl rejects the version, or says it is unsupported | The version in `eks-cluster.yaml` is newer than your eksctl supports. | Use `"1.35"`, or update eksctl. |
| Error about Amazon Linux 2 | `amiFamily: AmazonLinux2` is not allowed on 1.33 and later. | Use `AmazonLinux2023`. |
| Error that subnets must be in at least two availability zones | Only one zone was listed for the cluster. | Keep two zones under `availabilityZones`. Limit only the node group to one zone. |
| `eksctl: command not found` right after installing it | The terminal was open before the install changed `PATH`. | Open a new terminal. |

### Images

| What you see | Cause | Fix |
|---|---|---|
| `Your Authorization Token is invalid` at login | PowerShell 5.1 changed the token in the pipe. | Use Git Bash, or the `cmd /c` command in Step 6. |
| `no basic auth credentials` or `denied` on push | The login expired (it lasts 12 hours) or used a different account or region. | Run the login again with your `<ACCOUNT_ID>` and `ap-south-1`. |
| Pods show `ImagePullBackOff` | The image line names another account or region, or the image was never pushed. | Step 5 and Step 6. `kubectl describe pod <pod> -n blog` shows the exact image it tried. |
| Pods show `exec format error` | The image was built for ARM (Apple Silicon). | Rebuild with `--platform linux/amd64`. |

### Database

| What you see | Cause | Fix |
|---|---|---|
| The `nc` test in Step 10 times out | The inbound rule on `blog-rds-sg` is missing or names the wrong group, or RDS is in a different VPC. | Step 7 and Step 8. Check that `<CLUSTER_SG>` matches the group on the nodes. |
| `Access denied for user 'admin'` | The password in `blog-secrets` is not the RDS password. | Fix `k8s/secrets.yaml`, `kubectl apply` it again, then `kubectl rollout restart deployment -n blog`. |
| `Unknown database 'auth_db'` | Step 11 was skipped. | Run Step 11. |
| Pods keep restarting with `CrashLoopBackOff` | Usually the database. | `kubectl logs <pod> -n blog --previous` shows the error. |

### Domain and certificate

| What you see | Cause | Fix |
|---|---|---|
| `curl -H "Host: ..."` to `<LB_DNS>` returns `000` | The new load balancer is still starting. | Wait 2 to 3 minutes. |
| Only `www.<DOMAIN>` resolves | The record for the bare domain is missing. | Step 17 part C: create both records. |
| The NS lookup still shows GoDaddy name servers | The change has not spread yet. | Wait, then check again. |
| Challenge says `failed to perform self check ... context deadline exceeded` | The cluster cannot reach its own domain through the load balancer. | Step 18. |
| Challenge says `connection refused` or `NXDOMAIN` from Let's Encrypt | DNS does not point at the load balancer yet. | Step 17 part D. |
| The browser warns about the certificate | The certificate is not issued yet, so ingress-nginx serves a temporary one. | `kubectl get certificate -n blog` must show `READY True`. |

### Useful commands

```bash
# Everything in the app namespace
kubectl get all -n blog

# Why a pod is not starting
kubectl describe pod <pod-name> -n blog

# Logs of one service
kubectl logs deployment/post-service -n blog --tail=50

# Certificate progress
kubectl describe certificate -n blog
kubectl get challenge -n blog

# Ingress controller logs
kubectl logs deployment/ingress-nginx-controller -n ingress-nginx --tail=50
```

---

## 25. Clean up

When the lab is over, remove the resources so nothing keeps costing money. **Work in this order.** The load balancer and the database sit inside the cluster's VPC, and eksctl cannot delete the VPC while they still exist.

1. **Load balancer:** delete ingress-nginx. Kubernetes deletes the Network Load Balancer with it.

   ```bash
   kubectl delete namespace ingress-nginx
   ```

2. **RDS instance.** `--skip-final-snapshot` throws the data away. Leave it out if you want to keep a backup.

   ```bash
   aws rds delete-db-instance --db-instance-identifier blog-platform-db \
     --skip-final-snapshot --delete-automated-backups --region ap-south-1
   aws rds wait db-instance-deleted --db-instance-identifier blog-platform-db --region ap-south-1
   ```

3. **RDS subnet group and security group.** First remove the cluster's outbound rule, because it refers to `blog-rds-sg` and blocks its deletion:

   ```bash
   aws ec2 revoke-security-group-egress --group-id <CLUSTER_SG> --region ap-south-1 \
     --ip-permissions "IpProtocol=tcp,FromPort=3306,ToPort=3306,UserIdGroupPairs=[{GroupId=<RDS_SG>}]"
   aws rds delete-db-subnet-group --db-subnet-group-name blog-db-subnets --region ap-south-1
   aws ec2 delete-security-group --group-id <RDS_SG> --region ap-south-1
   ```

4. **ECR repositories and their images:**

   ```bash
   for r in blog-auth-service blog-post-service blog-comment-service blog-frontend; do
     aws ecr delete-repository --repository-name $r --force --region ap-south-1
   done
   ```

5. **EKS cluster.** This also deletes the node group, the VPC, the subnets and the NAT gateway. It takes 10 to 15 minutes.

   ```bash
   eksctl delete cluster -f eks-cluster.yaml --wait --disable-nodegroup-eviction
   ```

6. **CloudWatch log group.** eksctl leaves it behind:

   ```bash
   aws logs delete-log-group --log-group-name /aws/eks/blog-cluster/cluster --region ap-south-1
   ```

   > In Git Bash, put `MSYS_NO_PATHCONV=1` in front of this command, or Git Bash turns `/aws/...` into a Windows path.

7. **Route 53:** delete the two A alias records. Delete the hosted zone too if you no longer need the domain on AWS. If you delete the zone and later create a new one, it gets **different** name servers, and you must update GoDaddy again.

8. **Check that nothing is left:**

   ```bash
   aws eks list-clusters --region ap-south-1
   aws rds describe-db-instances --region ap-south-1 --query "DBInstances[].DBInstanceIdentifier"
   aws elbv2 describe-load-balancers --region ap-south-1 --query "LoadBalancers[].LoadBalancerName"
   aws ecr describe-repositories --region ap-south-1 --query "repositories[].repositoryName"
   ```

   Each command should return an empty list.

The costs in this lab come from the EKS control plane, the three EC2 nodes, the NAT gateway, the Network Load Balancer and the RDS instance, all billed by the hour while they exist. The Route 53 hosted zone costs a small fixed amount per month.
