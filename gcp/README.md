# GCP deployment track

This folder contains the GCP architecture, beginner-oriented deployment walkthrough, and GCP-specific Kubernetes manifests for the existing blog microservices project. Application source and Dockerfiles remain shared in the repository root under `services/` and `frontend/`.

## Start here

1. Read [docs/gcp-deployment-walkthrough.md](docs/gcp-deployment-walkthrough.md) and provision services in the order shown.
2. Review [architecture-diagram.html](architecture-diagram.html) for the traffic flow and AWS-to-GCP mappings.
3. Apply manifests from `k8s/` only after replacing project/domain/email placeholders and creating the database Secret as instructed.

The guide is Console-first. PowerShell, Docker Desktop, `gcloud`, `kubectl`, and Helm are used for local image builds and Kubernetes tasks that are impractical in the Console. It deploys four applications with two replicas each and connects to Cloud SQL over private IP.

| AWS component | GCP equivalent |
| --- | --- |
| Route 53 / DNS | Cloud DNS |
| AWS Network Load Balancer | GKE external passthrough Network Load Balancer, created by the NGINX Ingress LoadBalancer Service |
| EKS and EC2 worker nodes | GKE Standard and Compute Engine worker nodes |
| Amazon ECR | Artifact Registry |
| Amazon RDS MySQL | Cloud SQL for MySQL |
| VPC, private subnets, security group | VPC network, subnet, and VPC firewall rules |
| Kubernetes Secret | Secret in the `blog` namespace |
| ECR image pull role | GKE node service account with Artifact Registry Reader permission |

The AWS configuration and shared app source remain unchanged. The community ingress-nginx project is retired; it is retained for architecture parity and learning, not recommended for new production systems.
