# MySocialSpace: AI-powered monitoring with Prometheus and Grafana

A step-by-step guide for adding monitoring to the MySocialSpace blog platform on Amazon EKS, then adding three AI use cases on top of the Prometheus data:

| # | Use case | Problem | How AI helps | Result |
|---|----------|---------|--------------|--------|
| 1 | **Smart anomaly detection** | Static thresholds (CPU > 80%) create noisy alerts and miss slow degradations. | A model learns each service's normal baseline by time of day and flags unusual latency, error rate or traffic. | Fewer false alerts, earlier detection. |
| 2 | **AI alert summary and root cause** | An email that only says "PodCrashLooping" gives no context. | An LLM receives the alert through a webhook, reads related metrics, pod logs and Kubernetes events, then adds a plain-English summary, likely cause and next steps to the Gmail email. | Faster triage, lower MTTR. |
| 3 | **Predictive capacity and scaling** | HPA reacts only after load arrives; disks and nodes fill up without warning. | Forecasting models on historical Prometheus data predict traffic peaks and memory/disk exhaustion, pre-scale pods and nodes (Karpenter), and warn days ahead. | No surprise outages, right-sized cost. |

- **Starting point:** the application is already running on EKS, as described in [eks-deployment-walkthrough.md](eks-deployment-walkthrough.md). Pods in the `blog` namespace are `Running` and the site opens over HTTPS.
- **End result:** Prometheus, Alertmanager and Grafana run in a `monitoring` namespace; the three services export request metrics; alerts arrive in Gmail with an AI-written summary; anomaly and forecast metrics drive alerts, pod autoscaling and node pre-scaling.
- **Time:** about 3 to 4 hours of work. The anomaly and forecast models need **at least 2 days** of collected data before they produce useful output, and get noticeably better after 2 weeks.

> All commands are written for a **bash** terminal (Linux, macOS, or **Git Bash** on Windows), the same as the deployment walkthrough.

---

## Contents

**Part 1: Prometheus and Grafana**

1. [How the monitoring works](#1-how-the-monitoring-works)
2. [What you need before you start](#2-what-you-need-before-you-start)
3. [Write down your values](#3-write-down-your-values)
4. [Step 1: Check cluster capacity](#4-step-1-check-cluster-capacity)
5. [Step 2: Install the EBS CSI driver and a gp3 storage class](#5-step-2-install-the-ebs-csi-driver-and-a-gp3-storage-class)
6. [Step 3: Create the monitoring namespace and secrets](#6-step-3-create-the-monitoring-namespace-and-secrets)
7. [Step 4: Write the kube-prometheus-stack values file](#7-step-4-write-the-kube-prometheus-stack-values-file)
8. [Step 5: Install Prometheus, Alertmanager and Grafana](#8-step-5-install-prometheus-alertmanager-and-grafana)
9. [Step 6: Open Grafana](#9-step-6-open-grafana)
10. [Step 7: Add a /metrics endpoint to the three services](#10-step-7-add-a-metrics-endpoint-to-the-three-services)
11. [Step 8: Tell Prometheus to scrape the services and ingress-nginx](#11-step-8-tell-prometheus-to-scrape-the-services-and-ingress-nginx)
12. [Step 9: Add golden-signal recording rules and basic alerts](#12-step-9-add-golden-signal-recording-rules-and-basic-alerts)
13. [Step 10: Test the Gmail alert email](#13-step-10-test-the-gmail-alert-email)
14. [Step 11: Import dashboards](#14-step-11-import-dashboards)
15. [Step 12: Generate steady test traffic (lab clusters)](#15-step-12-generate-steady-test-traffic-lab-clusters)

**Part 2: Use case 1, smart anomaly detection**

16. [Step 13: Add statistical baseline rules](#16-step-13-add-statistical-baseline-rules)
17. [Step 14: Build the ML anomaly detector](#17-step-14-build-the-ml-anomaly-detector)
18. [Step 15: Deploy the anomaly detector](#18-step-15-deploy-the-anomaly-detector)
19. [Step 16: Alert on the anomaly scores](#19-step-16-alert-on-the-anomaly-scores)

**Part 3: Use case 2, AI alert summary and root cause**

20. [Step 17: Get an Anthropic API key and store the secrets](#20-step-17-get-an-anthropic-api-key-and-store-the-secrets)
21. [Step 18: Build the alert summarizer](#21-step-18-build-the-alert-summarizer)
22. [Step 19: Deploy the alert summarizer](#22-step-19-deploy-the-alert-summarizer)
23. [Step 20: Route Alertmanager through the summarizer](#23-step-20-route-alertmanager-through-the-summarizer)
24. [Step 21: Test with a crash-looping pod](#24-step-21-test-with-a-crash-looping-pod)

**Part 4: Use case 3, predictive capacity and scaling**

25. [Step 22: Add predict_linear early-warning alerts](#25-step-22-add-predict_linear-early-warning-alerts)
26. [Step 23: Build and deploy the capacity forecaster](#26-step-23-build-and-deploy-the-capacity-forecaster)
27. [Step 24: Pre-scale pods with KEDA](#27-step-24-pre-scale-pods-with-keda)
28. [Step 25: Pre-scale nodes with Karpenter](#28-step-25-pre-scale-nodes-with-karpenter)
29. [Step 26: Build the AI Monitoring dashboard](#29-step-26-build-the-ai-monitoring-dashboard)

**Reference**

30. [Summary of everything you created](#30-summary-of-everything-you-created)
31. [Cost](#31-cost)
32. [Troubleshooting](#32-troubleshooting)
33. [Clean up](#33-clean-up)

---

# Part 1: Prometheus and Grafana

## 1. How the monitoring works

```
                        ┌──────────────────────── namespace: blog ────────────────────────┐
                        │ auth-service  post-service  comment-service   (GET /metrics)     │
                        └───────────────▲───────────────────────────────────────▲─────────┘
                                        │ scrape every 30s                       │ pre-scale (KEDA)
┌──────────────────────────── namespace: monitoring ─────────────────────────────┼──────────┐
│                                                                                 │          │
│  node-exporter ─┐                                                               │          │
│  kube-state-   ─┼──▶ Prometheus (30 days on EBS gp3) ──▶ Grafana (dashboards)   │          │
│  metrics        │        │  ▲            │                                      │          │
│  ingress-nginx ─┘        │  │ scrape     │ firing alerts                        │          │
│                          │  │            ▼                                      │          │
│              query history │       Alertmanager ──webhook──▶ alert-summarizer ──┼──▶ Claude API
│                          ▼  │                                  │  reads logs,    │          │
│      anomaly-detector  ─────┤                                  │  events, metrics│          │
│      capacity-forecaster ───┘  (expose ai_* metrics)           ▼                 │          │
│                                                           Gmail SMTP ──▶ your inbox        │
└────────────────────────────────────────────────────────────────────────────────────────────┘
                                          Karpenter adds nodes when placeholder pods are pending
```

| Component | Installed by | What it does |
|-----------|--------------|--------------|
| Prometheus | kube-prometheus-stack (Helm) | Scrapes and stores metrics; evaluates recording and alert rules. |
| Alertmanager | kube-prometheus-stack | Groups alerts and sends them to Gmail or the summarizer webhook. |
| Grafana | kube-prometheus-stack | Dashboards. Prometheus is pre-configured as its data source. |
| node-exporter | kube-prometheus-stack | Node CPU, memory, disk, network. One pod per node. |
| kube-state-metrics | kube-prometheus-stack | Kubernetes object state: restarts, replicas, requests, limits. |
| prom-client | npm, inside each service | Exposes request count and latency at `/metrics`. |
| anomaly-detector | you build it (Python) | Learns normal behaviour per service and time of day; exports `ai_anomaly_*`. |
| alert-summarizer | you build it (Python) | Receives alerts, collects context, asks Claude for a summary, emails it. |
| capacity-forecaster | you build it (Python) | Forecasts traffic 15 minutes to 7 days ahead; exports `ai_forecast_*`. |
| KEDA | Helm | Scales deployments on the forecast as well as on CPU. |
| Karpenter | Helm | Adds EC2 nodes when pods cannot be scheduled. |

You will create a `monitoring/` folder in the repository for everything in this guide:

```
monitoring/
├── storageclass-gp3.yaml
├── kube-prometheus-stack-values.yaml
├── servicemonitors.yaml
├── ingress-nginx-metrics.yaml
├── rules/
│   ├── golden-signals.yaml
│   ├── anomaly-rules.yaml
│   ├── ai-anomaly-alerts.yaml
│   └── capacity-rules.yaml
├── anomaly-detector/       app.py  requirements.txt  Dockerfile  k8s.yaml
├── alert-summarizer/       app.py  requirements.txt  Dockerfile  k8s.yaml
├── capacity-forecaster/    app.py  requirements.txt  Dockerfile  k8s.yaml
├── keda/                   scaledobjects.yaml  placeholder.yaml
└── karpenter/              nodepool.yaml
```

---

## 2. What you need before you start

Everything from the deployment walkthrough (AWS CLI, eksctl, kubectl, Docker), plus:

| Tool / account | Check | Install |
|----------------|-------|---------|
| Helm 3 | `helm version` | https://helm.sh/docs/intro/install/ |
| Python 3.12 (only for testing code locally; optional) | `python --version` | https://www.python.org/downloads/ |
| A Gmail account with 2-Step Verification on | — | Needed to create an app password |
| An Anthropic API key | — | https://console.anthropic.com/ (Part 3) |

**Create a Gmail app password.** Gmail does not accept your normal password over SMTP.

1. Turn on 2-Step Verification at https://myaccount.google.com/security.
2. Open https://myaccount.google.com/apppasswords, create an app password named `alertmanager`, and copy the 16-character value (without spaces).

**Checkpoint:** `helm version` prints v3.x, and you have the Gmail app password saved somewhere safe.

---

## 3. Write down your values

Run this in every new terminal before you continue. Replace the `<...>` values.

```bash
export AWS_ACCOUNT_ID=769093516181
export AWS_REGION=ap-south-1
export CLUSTER_NAME=blog-cluster                 # name in eks-cluster.yaml
export ECR_REGISTRY=$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com
export DOMAIN=<DOMAIN>                           # e.g. bharathonlineshopping.com
export GMAIL_USER=<you@gmail.com>                # sends the alerts
export ALERT_EMAIL_TO=<on-call@example.com>      # receives the alerts (can be the same)
```

> The GitHub Actions workflow uses `EKS_CLUSTER: project-k8s-cluster`, while `eks-cluster.yaml` names the cluster `blog-cluster`. Use whichever name `aws eks list-clusters --region ap-south-1` shows.

Check that kubectl points at the right cluster:

```bash
aws eks update-kubeconfig --name $CLUSTER_NAME --region $AWS_REGION
kubectl get nodes
kubectl get pods -n blog
```

**Checkpoint:** three nodes are `Ready`, and all pods in `blog` are `Running`.

---

## 4. Step 1: Check cluster capacity

The cluster has three **t3.medium** nodes (2 vCPU, 4 GiB each). With the default VPC CNI, a t3.medium can run at most **17 pods**, including system pods. This guide adds roughly 20 pods across the cluster (Prometheus stack, EBS CSI driver, three AI services, KEDA, Karpenter), and Prometheus needs about 1 GiB of memory.

```bash
# Pods per node (limit is 17)
kubectl get pods -A -o wide --field-selector=status.phase=Running \
  | awk 'NR>1 {print $8}' | sort | uniq -c

# CPU and memory already requested on each node
kubectl describe nodes | grep -A 8 "Allocated resources"
```

If any node already runs 12 or more pods, or requests above 70% of memory, add capacity first. The simplest way is to raise the node group size in `eks-cluster.yaml` and apply it:

```bash
eksctl scale nodegroup --cluster $CLUSTER_NAME --region $AWS_REGION \
  --name blog-workers --nodes 4 --nodes-max 4
```

Karpenter (Step 25) adds nodes automatically later; until then the node group size is fixed.

**Checkpoint:** every node has at least 6 free pod slots and about 1.5 GiB of unrequested memory across the cluster.

---

## 5. Step 2: Install the EBS CSI driver and a gp3 storage class

Prometheus must keep its data when its pod restarts, or the anomaly and forecast models lose their history. On EKS, persistent volumes need the **Amazon EBS CSI driver** add-on, which the cluster does not have yet.

1. Enable the IAM OIDC provider (safe to run if it already exists):

   ```bash
   eksctl utils associate-iam-oidc-provider \
     --cluster $CLUSTER_NAME --region $AWS_REGION --approve
   ```

2. Create the IAM role the driver uses:

   ```bash
   eksctl create iamserviceaccount \
     --cluster $CLUSTER_NAME --region $AWS_REGION \
     --namespace kube-system --name ebs-csi-controller-sa \
     --role-name AmazonEKS_EBS_CSI_DriverRole_$CLUSTER_NAME \
     --attach-policy-arn arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy \
     --role-only --approve
   ```

3. Install the add-on:

   ```bash
   eksctl create addon --cluster $CLUSTER_NAME --region $AWS_REGION \
     --name aws-ebs-csi-driver \
     --service-account-role-arn arn:aws:iam::$AWS_ACCOUNT_ID:role/AmazonEKS_EBS_CSI_DriverRole_$CLUSTER_NAME \
     --force
   ```

4. Create `monitoring/storageclass-gp3.yaml`:

   ```yaml
   apiVersion: storage.k8s.io/v1
   kind: StorageClass
   metadata:
     name: gp3
   provisioner: ebs.csi.aws.com
   volumeBindingMode: WaitForFirstConsumer   # create the volume in the AZ of the pod's node
   reclaimPolicy: Delete
   allowVolumeExpansion: true
   parameters:
     type: gp3
     encrypted: "true"
   ```

   ```bash
   kubectl apply -f monitoring/storageclass-gp3.yaml
   ```

5. Wait for the driver:

   ```bash
   kubectl rollout status deployment/ebs-csi-controller -n kube-system --timeout=180s
   kubectl get storageclass
   ```

> To keep the cluster definition complete, also add `- name: aws-ebs-csi-driver` under `addons:` in `eks-cluster.yaml`.

**Checkpoint:** `ebs-csi-controller` is rolled out and `kubectl get storageclass` lists `gp3`.

---

## 6. Step 3: Create the monitoring namespace and secrets

1. Create the namespace:

   ```bash
   kubectl create namespace monitoring
   ```

2. Create the Grafana admin login. Choose a strong password:

   ```bash
   kubectl create secret generic grafana-admin -n monitoring \
     --from-literal=admin-user=admin \
     --from-literal=admin-password='<A_STRONG_PASSWORD>'
   ```

3. Store the Gmail app password for Alertmanager. It is mounted into the Alertmanager pod as a file, so it never appears in the Helm values or in Git:

   ```bash
   kubectl create secret generic alertmanager-gmail -n monitoring \
     --from-literal=password='<GMAIL_APP_PASSWORD>'
   ```

**Checkpoint:** `kubectl get secret -n monitoring` lists `grafana-admin` and `alertmanager-gmail`.

---

## 7. Step 4: Write the kube-prometheus-stack values file

[kube-prometheus-stack](https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack) installs the Prometheus Operator, Prometheus, Alertmanager, Grafana, node-exporter, kube-state-metrics, and a set of ready-made alert rules and dashboards.

Create `monitoring/kube-prometheus-stack-values.yaml` and replace `<GMAIL_USER>`, `<ALERT_EMAIL_TO>` and `<DOMAIN>`:

```yaml
# Short, predictable names: kps-prometheus, kps-alertmanager, kps-grafana
fullnameOverride: kps

# EKS runs the control plane for you; these components cannot be scraped.
kubeEtcd:
  enabled: false
kubeControllerManager:
  enabled: false
kubeScheduler:
  enabled: false
kubeProxy:
  enabled: false
defaultRules:
  rules:
    etcd: false
    kubeControllerManager: false
    kubeSchedulerAlerting: false
    kubeSchedulerRecording: false
    kubeProxy: false

prometheus:
  prometheusSpec:
    scrapeInterval: 30s
    evaluationInterval: 30s
    # 30 days of history: the anomaly and forecast models train on it.
    retention: 30d
    retentionSize: 18GB
    # Pick up ServiceMonitors, PodMonitors and PrometheusRules from any
    # namespace, not only ones labelled for this Helm release.
    serviceMonitorSelectorNilUsesHelmValues: false
    podMonitorSelectorNilUsesHelmValues: false
    ruleSelectorNilUsesHelmValues: false
    resources:
      requests:
        cpu: 200m
        memory: 1Gi
      limits:
        memory: 2Gi
    storageSpec:
      volumeClaimTemplate:
        spec:
          storageClassName: gp3
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 20Gi

alertmanager:
  alertmanagerSpec:
    # Mounted at /etc/alertmanager/secrets/alertmanager-gmail/password
    secrets:
      - alertmanager-gmail
    resources:
      requests:
        cpu: 20m
        memory: 64Mi
    storage:
      volumeClaimTemplate:
        spec:
          storageClassName: gp3
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 2Gi
  config:
    global:
      smtp_smarthost: smtp.gmail.com:587
      smtp_from: <GMAIL_USER>
      smtp_auth_username: <GMAIL_USER>
      smtp_require_tls: true
    route:
      receiver: email
      group_by: [alertname, namespace, service]
      group_wait: 30s
      group_interval: 5m
      repeat_interval: 4h
      routes:
        # Watchdog always fires to prove the pipeline works; InfoInhibitor is internal.
        - receiver: "null"
          matchers:
            - alertname =~ "Watchdog|InfoInhibitor"
    receivers:
      - name: "null"
      - name: email
        email_configs:
          - to: <ALERT_EMAIL_TO>
            auth_password_file: /etc/alertmanager/secrets/alertmanager-gmail/password
            send_resolved: true

grafana:
  admin:
    existingSecret: grafana-admin
    userKey: admin-user
    passwordKey: admin-password
  defaultDashboardsTimezone: browser
  persistence:
    enabled: true
    storageClassName: gp3
    size: 5Gi
  # An EBS volume attaches to one node at a time, so stop the old pod first.
  deploymentStrategy:
    type: Recreate
  resources:
    requests:
      cpu: 50m
      memory: 128Mi
  # Public HTTPS access at https://grafana.<DOMAIN>. Leave disabled until Step 6.
  ingress:
    enabled: false
    ingressClassName: nginx
    annotations:
      cert-manager.io/cluster-issuer: letsencrypt-prod
    hosts:
      - grafana.<DOMAIN>
    tls:
      - secretName: grafana-tls
        hosts:
          - grafana.<DOMAIN>
  grafana.ini:
    server:
      root_url: https://grafana.<DOMAIN>

prometheus-node-exporter:
  resources:
    requests:
      cpu: 20m
      memory: 32Mi

kube-state-metrics:
  resources:
    requests:
      cpu: 20m
      memory: 64Mi
```

What the important settings do:

- `serviceMonitorSelectorNilUsesHelmValues: false` and `ruleSelectorNilUsesHelmValues: false`: without these, Prometheus ignores the ServiceMonitors and rules you create later in this guide.
- `retention: 30d` on a 20 GiB gp3 volume: enough history for weekly seasonality. `retentionSize` deletes old data before the disk is full.
- `auth_password_file`: Alertmanager reads the Gmail app password from the mounted secret.

**Checkpoint:** the file exists and contains no `<...>` placeholders: `grep -n "<" monitoring/kube-prometheus-stack-values.yaml` prints nothing.

---

## 8. Step 5: Install Prometheus, Alertmanager and Grafana

1. Add the chart repository and see the latest version:

   ```bash
   helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
   helm repo update
   helm search repo prometheus-community/kube-prometheus-stack
   ```

   Write down the `CHART VERSION` as `<KPS_VERSION>`. Pinning it means upgrades happen only when you choose.

2. Install:

   ```bash
   helm upgrade --install kps prometheus-community/kube-prometheus-stack \
     --namespace monitoring \
     --version <KPS_VERSION> \
     -f monitoring/kube-prometheus-stack-values.yaml \
     --wait --timeout 10m
   ```

3. Check what was created:

   ```bash
   kubectl get pods -n monitoring
   kubectl get pvc -n monitoring
   ```

   You should see `kps-operator`, `prometheus-kps-prometheus-0`, `alertmanager-kps-alertmanager-0`, `kps-grafana`, `kps-kube-state-metrics`, and one `kps-prometheus-node-exporter` per node. Two or three PVCs should be `Bound`.

**Checkpoint:** all pods in `monitoring` are `Running` and every PVC is `Bound`.

---

## 9. Step 6: Open Grafana

**Option A: port-forward (private, no DNS changes).**

```bash
kubectl port-forward -n monitoring svc/kps-grafana 3000:80
```

Open http://localhost:3000 and sign in with the user and password from `grafana-admin`. Leave the command running while you use Grafana.

Open Prometheus the same way when you need to check targets or try queries:

```bash
kubectl port-forward -n monitoring svc/kps-prometheus 9090:9090      # http://localhost:9090
kubectl port-forward -n monitoring svc/kps-alertmanager 9093:9093    # http://localhost:9093
```

**Option B: public HTTPS at `https://grafana.<DOMAIN>`.**

1. In Route 53, add an **A record (alias)** for `grafana.<DOMAIN>` pointing at the same load balancer as `<DOMAIN>` (see Step 17, Part C, of the deployment walkthrough).
2. Add a rewrite line for `grafana.<DOMAIN>` to your `coredns-config.yaml` from Step 18 of the walkthrough, next to the two existing ones, and apply it the same way. Without it, cert-manager's self-check fails for the new host.

   ```
   rewrite name exact grafana.<DOMAIN> ingress-nginx-controller.ingress-nginx.svc.cluster.local answer auto
   ```

3. Set `grafana.ingress.enabled: true` in the values file and re-run the `helm upgrade --install` command from Step 5.
4. Wait for the certificate: `kubectl get certificate -n monitoring` should show `grafana-tls  True`.

> Grafana on the internet is protected only by its login. Use a strong password, or keep using port-forward.

**Checkpoint:** you are signed in to Grafana, **Connections → Data sources** lists Prometheus and Alertmanager, and **Dashboards** contains the bundled "Kubernetes / Compute Resources / ..." dashboards showing data.

---

## 10. Step 7: Add a /metrics endpoint to the three services

Prometheus can already see nodes and pods, but not requests, errors or latency inside the services. You add those with [prom-client](https://github.com/siimon/prom-client). Repeat this step for `auth-service`, `post-service` and `comment-service`.

1. Install the package (from the repository root):

   ```bash
   for s in auth-service post-service comment-service; do
     (cd services/$s && npm install prom-client)
   done
   ```

2. Create `services/<service>/src/lib/metrics.ts` (the same file in all three services):

   ```typescript
   import { Request, Response, NextFunction } from 'express';
   import client from 'prom-client';

   export const register = new client.Registry();

   // Node.js process metrics: CPU, memory, event loop lag, GC.
   client.collectDefaultMetrics({ register });

   const httpRequestDuration = new client.Histogram({
     name: 'http_request_duration_seconds',
     help: 'HTTP request duration in seconds',
     labelNames: ['method', 'route', 'status_code'],
     buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
     registers: [register],
   });

   // Records one observation per request. Uses the route pattern
   // (/api/posts/:id), not the raw URL, so the number of series stays small.
   export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
     if (req.path === '/metrics' || req.path === '/health') return next();
     const end = httpRequestDuration.startTimer();
     res.on('finish', () => {
       const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
       end({ method: req.method, route, status_code: String(res.statusCode) });
     });
     next();
   }

   export async function metricsHandler(_req: Request, res: Response) {
     res.set('Content-Type', register.contentType);
     res.end(await register.metrics());
   }
   ```

3. Wire it into `src/index.ts`. For `post-service` the result looks like this (the other two are the same, with their own router):

   ```typescript
   import express from 'express';
   import cors from 'cors';
   import postsRouter from './routes/posts';
   import { metricsMiddleware, metricsHandler } from './lib/metrics';

   const app = express();
   const PORT = process.env.PORT || 3002;

   app.use(cors());
   app.use(express.json());
   app.use(metricsMiddleware);

   // Health check
   app.get('/health', (_req, res) => {
     res.json({ status: 'ok', service: 'post-service' });
   });

   // Prometheus metrics
   app.get('/metrics', metricsHandler);

   // Routes
   app.use('/api/posts', postsRouter);

   app.listen(PORT, () => {
     console.log(`post-service running on port ${PORT}`);
   });
   ```

   `/metrics` is not reachable from the internet: the ingress only forwards `/api/auth`, `/api/posts` and `/api/comments` to the services, and everything else goes to the frontend.

4. Check it locally (optional):

   ```bash
   cd services/post-service && npm run build && cd ../..
   ```

5. Name the port and label each Service so Prometheus can find it. Edit `k8s/auth-service/service.yaml` (and the same for post-service on 3002 and comment-service on 3003):

   ```yaml
   apiVersion: v1
   kind: Service
   metadata:
     name: auth-service
     namespace: blog
     labels:
       monitoring: enabled
   spec:
     selector:
       app: auth-service
     ports:
       - name: http
         port: 3001
         targetPort: 3001
     type: ClusterIP
   ```

   ```bash
   kubectl apply -f k8s/auth-service/service.yaml \
                 -f k8s/post-service/service.yaml \
                 -f k8s/comment-service/service.yaml
   ```

6. Deploy the new code. Push to `master` and the GitHub Actions workflow builds and rolls out each changed service. Or build and push by hand, as in Step 6 of the walkthrough, then:

   ```bash
   kubectl rollout restart deployment/auth-service deployment/post-service deployment/comment-service -n blog
   ```

7. Check one pod:

   ```bash
   kubectl exec -n blog deploy/post-service -- wget -qO- localhost:3002/metrics | grep http_request_duration_seconds_count
   ```

   The line appears after the service has handled at least one request (open the site once).

**Checkpoint:** the `/metrics` output of each service contains `http_request_duration_seconds_count` and `nodejs_heap_size_used_bytes`.

---

## 11. Step 8: Tell Prometheus to scrape the services and ingress-nginx

A **ServiceMonitor** tells the Prometheus Operator which Services to scrape.

1. Create `monitoring/servicemonitors.yaml`:

   ```yaml
   # The three application services in the blog namespace
   apiVersion: monitoring.coreos.com/v1
   kind: ServiceMonitor
   metadata:
     name: blog-services
     namespace: monitoring
   spec:
     namespaceSelector:
       matchNames: [blog]
     selector:
       matchLabels:
         monitoring: enabled
     endpoints:
       - port: http
         path: /metrics
         interval: 30s
   ---
   # The ingress-nginx controller
   apiVersion: monitoring.coreos.com/v1
   kind: ServiceMonitor
   metadata:
     name: ingress-nginx
     namespace: monitoring
   spec:
     namespaceSelector:
       matchNames: [ingress-nginx]
     selector:
       matchLabels:
         monitoring: enabled
     endpoints:
       - port: metrics
         interval: 30s
         # ingress-nginx metrics carry their own "service" label (the backend);
         # keep it instead of renaming it to exported_service.
         honorLabels: true
   ---
   # The AI services you build later (anomaly-detector, capacity-forecaster)
   apiVersion: monitoring.coreos.com/v1
   kind: ServiceMonitor
   metadata:
     name: ai-monitoring
     namespace: monitoring
   spec:
     namespaceSelector:
       matchNames: [monitoring]
     selector:
       matchLabels:
         ai-monitoring: "true"
     endpoints:
       - port: metrics
         interval: 30s
         honorLabels: true
   ```

2. ingress-nginx serves metrics on port 10254, but the manifest you installed does not expose that port in a Service. Create `monitoring/ingress-nginx-metrics.yaml`:

   ```yaml
   apiVersion: v1
   kind: Service
   metadata:
     name: ingress-nginx-controller-metrics
     namespace: ingress-nginx
     labels:
       monitoring: enabled
   spec:
     type: ClusterIP
     selector:
       app.kubernetes.io/name: ingress-nginx
       app.kubernetes.io/component: controller
     ports:
       - name: metrics
         port: 10254
         targetPort: 10254
   ```

3. Apply both:

   ```bash
   kubectl apply -f monitoring/ingress-nginx-metrics.yaml -f monitoring/servicemonitors.yaml
   ```

4. Wait a minute, then open Prometheus (`http://localhost:9090` with the port-forward from Step 6) and go to **Status → Targets**. Search for `blog-services` and `ingress-nginx`.

5. Try a query in the **Graph** tab:

   ```promql
   sum by (service) (rate(http_request_duration_seconds_count{namespace="blog"}[5m]))
   ```

**Checkpoint:** the targets `serviceMonitor/monitoring/blog-services/0` (6 endpoints, two per service) and `serviceMonitor/monitoring/ingress-nginx/0` are **UP**, and the query returns one series per service.

---

## 12. Step 9: Add golden-signal recording rules and basic alerts

**Recording rules** pre-compute expensive queries and store the result as a new metric. The three "golden signals" below (traffic, errors, latency per service) are what all three AI use cases read.

Create `monitoring/rules/golden-signals.yaml`:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: blog-golden-signals
  namespace: monitoring
spec:
  groups:
    - name: blog.golden-signals
      interval: 30s
      rules:
        # Requests per second, per service
        - record: service:http_requests:rate5m
          expr: sum by (service) (rate(http_request_duration_seconds_count{namespace="blog"}[5m]))

        # Share of requests that returned 5xx (0 to 1). The "or 0 *" part
        # returns 0 instead of nothing when a service has no errors.
        - record: service:http_errors:ratio_rate5m
          expr: |
            (
              sum by (service) (rate(http_request_duration_seconds_count{namespace="blog", status_code=~"5.."}[5m]))
              or
              0 * sum by (service) (rate(http_request_duration_seconds_count{namespace="blog"}[5m]))
            )
            /
            clamp_min(sum by (service) (rate(http_request_duration_seconds_count{namespace="blog"}[5m])), 1e-9)

        # 95th percentile latency in seconds. ">= 0" drops the NaN that
        # appears when a service had no requests, so it does not poison baselines.
        - record: service:http_latency_p95:5m
          expr: |
            histogram_quantile(0.95,
              sum by (service, le) (rate(http_request_duration_seconds_bucket{namespace="blog"}[5m]))
            ) >= 0

    - name: blog.basic-alerts
      rules:
        - alert: BlogServiceDown
          expr: up{namespace="blog", job=~"auth-service|post-service|comment-service"} == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "{{ $labels.job }} pod {{ $labels.pod }} cannot be scraped"
            description: "Prometheus has not reached {{ $labels.pod }} for 5 minutes."

        # Safety net. The anomaly alerts in Part 2 catch smaller, unusual changes.
        - alert: BlogHighErrorRate
          expr: service:http_errors:ratio_rate5m > 0.05 and on(service) service:http_requests:rate5m > 0.1
          for: 10m
          labels:
            severity: critical
          annotations:
            summary: "{{ $labels.service }} returns 5xx for {{ $value | humanizePercentage }} of requests"
            description: "More than 5% of requests to {{ $labels.service }} failed for 10 minutes."
```

```bash
kubectl apply -f monitoring/rules/golden-signals.yaml
```

kube-prometheus-stack already ships around 100 alerts, including `KubePodCrashLooping`, `KubeDeploymentReplicasMismatch`, `NodeFilesystemSpaceFillingUp`, `KubePersistentVolumeFillingUp` and `KubeMemoryOvercommit`. You do not need to write those yourself.

**Checkpoint:** in Prometheus, **Status → Rules** shows the `blog.golden-signals` group with state OK, and the query `service:http_requests:rate5m` returns data.

---

## 13. Step 10: Test the Gmail alert email

Send a fake alert straight to Alertmanager:

```bash
kubectl port-forward -n monitoring svc/kps-alertmanager 9093:9093 &
sleep 3
curl -s -XPOST http://localhost:9093/api/v2/alerts -H 'Content-Type: application/json' -d '[
  {"labels": {"alertname": "TestAlert", "severity": "warning", "namespace": "blog", "service": "post-service"},
   "annotations": {"description": "Manual test alert from the monitoring guide"}}
]'
```

After about 30 seconds (`group_wait`), an email titled `[FIRING:1] TestAlert ...` arrives at `<ALERT_EMAIL_TO>`. Check the spam folder the first time and mark it "Not spam".

If no email arrives:

```bash
kubectl logs -n monitoring alertmanager-kps-alertmanager-0 -c alertmanager | grep -i -E "smtp|email|error"
```

`535 5.7.8 Username and Password not accepted` means the app password or `<GMAIL_USER>` is wrong. Fix the secret and restart Alertmanager:

```bash
kubectl delete secret alertmanager-gmail -n monitoring
kubectl create secret generic alertmanager-gmail -n monitoring --from-literal=password='<GMAIL_APP_PASSWORD>'
kubectl delete pod alertmanager-kps-alertmanager-0 -n monitoring
```

**Checkpoint:** the test email is in your inbox. This is the plain alert email that Part 3 improves.

---

## 14. Step 11: Import dashboards

kube-prometheus-stack already installed dashboards for the cluster, nodes, namespaces and pods. Add these community dashboards with **Dashboards → New → Import**, enter the ID, and pick the Prometheus data source:

| ID | Dashboard | Shows |
|----|-----------|-------|
| 1860 | Node Exporter Full | Everything about each node: CPU, memory, disk, network |
| 9614 | NGINX Ingress controller | Requests, success rate and latency at the ingress |
| 15757 | Kubernetes / Views / Global | Cluster overview |
| 15760 | Kubernetes / Views / Pods | Per-pod resources and restarts |
| 11159 | NodeJS Application Dashboard | Event loop lag, heap, GC from `collectDefaultMetrics` |

You will build the AI Monitoring dashboard in Step 26, once the AI metrics exist.

**Checkpoint:** "Node Exporter Full" shows three nodes and "NGINX Ingress controller" shows requests after you open the site a few times.

---

## 15. Step 12: Generate steady test traffic (lab clusters)

The models learn what "normal" looks like. A lab site that nobody visits has no normal pattern, so every request would look like an anomaly. If your site has no real users, run a small load generator that varies over the day:

```bash
kubectl run loadgen -n blog --image=busybox:1.36 --restart=Always -- /bin/sh -c '
while true; do
  H=$(date +%H)
  # Busier between 09:00 and 22:00 UTC, quieter at night
  if [ $H -ge 9 ] && [ $H -le 22 ]; then N=10; else N=2; fi
  for i in $(seq $N); do
    wget -q -O /dev/null http://post-service:3002/api/posts
    wget -q -O /dev/null "http://comment-service:3003/api/comments?postId=1"
  done
  wget -q -O /dev/null http://auth-service:3001/api/auth/users/1 || true
  sleep 1
done'
```

Leave it running for the life of the lab. Delete it with `kubectl delete pod loadgen -n blog`.

**Checkpoint:** `service:http_requests:rate5m` shows a steady non-zero rate for all three services.

---

# Part 2: Use case 1, smart anomaly detection

Static thresholds treat 3 a.m. and 8 p.m. the same. This part uses two layers:

1. **Statistical baselines in PromQL** (Step 13). Run inside Prometheus, no extra code, useful after 1 day of data.
2. **An ML anomaly detector** (Steps 14 to 16). A Python service that learns each service's normal value **for each hour of the day** (and of the week, once 2 weeks of history exist), plus an Isolation Forest that spots unusual **combinations** of traffic, errors and latency.

## 16. Step 13: Add statistical baseline rules

Create `monitoring/rules/anomaly-rules.yaml`:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: blog-anomaly-baselines
  namespace: monitoring
spec:
  groups:
    - name: blog.anomaly-baselines
      interval: 1m
      rules:
        # --- Traffic -------------------------------------------------------
        - record: service:http_requests:rate5m:avg_1d
          expr: avg_over_time(service:http_requests:rate5m[1d])
        - record: service:http_requests:rate5m:stddev_1d
          expr: stddev_over_time(service:http_requests:rate5m[1d])
        # Expected traffic now = the same hour yesterday and a week ago
        # (1-hour windows centred on that time). Falls back to yesterday only
        # until a week of data exists.
        - record: service:http_requests:rate5m:seasonal_prediction
          expr: |
            (
              avg_over_time(service:http_requests:rate5m[1h] offset 23h30m)
              + avg_over_time(service:http_requests:rate5m[1h] offset 6d23h30m)
            ) / 2
            or
            avg_over_time(service:http_requests:rate5m[1h] offset 23h30m)

        # --- Latency -------------------------------------------------------
        - record: service:http_latency_p95:5m:avg_1d
          expr: avg_over_time(service:http_latency_p95:5m[1d])
        - record: service:http_latency_p95:5m:stddev_1d
          expr: stddev_over_time(service:http_latency_p95:5m[1d])

        # --- Errors --------------------------------------------------------
        - record: service:http_errors:ratio_rate5m:avg_1d
          expr: avg_over_time(service:http_errors:ratio_rate5m[1d])
        - record: service:http_errors:ratio_rate5m:stddev_1d
          expr: stddev_over_time(service:http_errors:ratio_rate5m[1d])

    - name: blog.anomaly-alerts
      rules:
        # Traffic is more than 3 standard deviations away from what is normal
        # for this time of day, in either direction (spike or sudden drop).
        - alert: TrafficAnomaly
          expr: |
            abs(service:http_requests:rate5m - service:http_requests:rate5m:seasonal_prediction)
              / clamp_min(service:http_requests:rate5m:stddev_1d, 0.05)
            > 3
            and on(service) service:http_requests:rate5m:seasonal_prediction > 0.1
          for: 15m
          labels:
            severity: warning
            detector: statistical
          annotations:
            summary: "Unusual traffic on {{ $labels.service }}"
            description: "Traffic on {{ $labels.service }} is {{ $value | printf \"%.1f\" }} standard deviations away from the usual level for this time of day."

        - alert: LatencyAnomaly
          expr: |
            (service:http_latency_p95:5m - service:http_latency_p95:5m:avg_1d)
              / clamp_min(service:http_latency_p95:5m:stddev_1d, 0.01)
            > 3
            and on(service) service:http_latency_p95:5m > 0.25
          for: 10m
          labels:
            severity: warning
            detector: statistical
          annotations:
            summary: "p95 latency of {{ $labels.service }} is unusually high"
            description: "p95 latency is {{ $value | printf \"%.1f\" }} standard deviations above its 24-hour average."

        - alert: ErrorRateAnomaly
          expr: |
            service:http_errors:ratio_rate5m
              > on(service) (service:http_errors:ratio_rate5m:avg_1d + 3 * service:http_errors:ratio_rate5m:stddev_1d)
            and on(service) service:http_errors:ratio_rate5m > 0.01
          for: 10m
          labels:
            severity: warning
            detector: statistical
          annotations:
            summary: "Unusual error rate on {{ $labels.service }}"
            description: "{{ $value | humanizePercentage }} of requests fail, well above the 24-hour normal."
```

```bash
kubectl apply -f monitoring/rules/anomaly-rules.yaml
```

How to read these rules:

- **z-score** = (value − expected) / standard deviation. Above 3 means "rarer than about 1 in 300 for a normal distribution".
- `clamp_min(..., 0.05)` sets a minimum spread. Without it, a perfectly flat history (stddev near 0) would turn any tiny change into a huge score.
- The `and ... > 0.1` / `> 0.25` / `> 0.01` parts ignore anomalies that do not matter: idle services, sub-250 ms latency, and error rates below 1%.
- `for: 10m` / `15m` means the condition must hold continuously, which removes one-off blips.

**Checkpoint:** after 1 day, `service:http_requests:rate5m:seasonal_prediction` returns data, and the three `*Anomaly` alerts are listed under **Alerts** in Prometheus as `inactive`.

---

## 17. Step 14: Build the ML anomaly detector

The detector runs a loop:

1. **Every hour, train.** Read up to 21 days of the three golden signals from Prometheus. For each service and signal, compute the **median** and **MAD** (median absolute deviation) for every hour of the day (or every hour of the week once 13+ days exist). Median and MAD ignore past incidents much better than mean and standard deviation. Also train an **Isolation Forest** per service on the combination of signals plus the time of day.
2. **Every minute, score.** Read the current values and publish:
   - `ai_anomaly_score{service, signal}`: robust z-score against the learned baseline for this hour.
   - `ai_anomaly_baseline{service, signal}`: the expected value right now (useful in Grafana).
   - `ai_anomaly_outlier_score{service}`: Isolation Forest score; above 0 means this combination is rarer than 99% of history.

Create `monitoring/anomaly-detector/app.py`:

```python
"""Learns each service's normal behaviour from Prometheus history and scores the present.

Exports Prometheus metrics on :9105/metrics:
  ai_anomaly_score{service, signal}     robust z-score vs the baseline for this hour
  ai_anomaly_baseline{service, signal}  expected value for this hour
  ai_anomaly_outlier_score{service}     Isolation Forest score (> 0 = unusual combination)
"""
import logging
import os
import time
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
import requests
from prometheus_client import Gauge, start_http_server
from sklearn.ensemble import IsolationForest

log = logging.getLogger("anomaly-detector")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

PROM = os.environ.get("PROMETHEUS_URL", "http://kps-prometheus.monitoring.svc:9090")
HISTORY_DAYS = int(os.environ.get("HISTORY_DAYS", "21"))
RETRAIN_SECONDS = int(os.environ.get("RETRAIN_SECONDS", "3600"))
SCORE_SECONDS = int(os.environ.get("SCORE_SECONDS", "60"))
MIN_POINTS = 288  # one day of 5-minute samples

# Recording rule for each signal, and the smallest spread accepted for it, so a
# perfectly flat history cannot make a tiny change look huge.
SIGNALS = {
    "traffic": ("service:http_requests:rate5m", 0.05),          # req/s
    "errors": ("service:http_errors:ratio_rate5m", 0.005),      # ratio
    "latency_p95": ("service:http_latency_p95:5m", 0.02),       # seconds
}

anomaly_score = Gauge("ai_anomaly_score", "Robust z-score against the learned baseline for this hour", ["service", "signal"])
baseline_value = Gauge("ai_anomaly_baseline", "Expected value for this hour", ["service", "signal"])
outlier_score = Gauge("ai_anomaly_outlier_score", "Isolation Forest score; above 0 means an unusual combination of signals", ["service"])
trained_at = Gauge("ai_anomaly_model_trained_timestamp_seconds", "When the models were last trained")


def query_range(expr: str, days: int) -> dict[str, pd.Series]:
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=days)
    r = requests.get(
        f"{PROM}/api/v1/query_range",
        params={"query": expr, "start": start.timestamp(), "end": end.timestamp(), "step": "5m"},
        timeout=120,
    )
    r.raise_for_status()
    out = {}
    for s in r.json()["data"]["result"]:
        index = pd.to_datetime([float(t) for t, _ in s["values"]], unit="s", utc=True)
        values = pd.to_numeric([v for _, v in s["values"]], errors="coerce")
        out[s["metric"].get("service", "unknown")] = pd.Series(values, index=index).dropna()
    return out


def query_now(expr: str) -> dict[str, float]:
    r = requests.get(f"{PROM}/api/v1/query", params={"query": expr}, timeout=30)
    r.raise_for_status()
    return {s["metric"].get("service", "unknown"): float(s["value"][1]) for s in r.json()["data"]["result"]}


def time_bucket(ts, weekly: bool):
    """Hour of the week (0-167) or hour of the day (0-23)."""
    return ts.dayofweek * 24 + ts.hour if weekly else ts.hour


class SeasonalBaseline:
    """Median and MAD of one signal for each hour of the day, or of the week once 13+ days exist."""

    def __init__(self, series: pd.Series, floor: float):
        self.weekly = (series.index.max() - series.index.min()) >= pd.Timedelta(days=13)
        grouped = series.groupby(time_bucket(series.index, self.weekly))
        self.median = grouped.median()
        self.mad = grouped.apply(lambda x: float(np.median(np.abs(x - x.median()))))
        self.floor = floor

    def score(self, value: float, now: pd.Timestamp):
        key = time_bucket(now, self.weekly)
        if key not in self.median.index:
            return None, None
        expected = float(self.median[key])
        # 1.4826 * MAD estimates the standard deviation for normally distributed data
        spread = max(1.4826 * float(self.mad[key]), self.floor)
        return (value - expected) / spread, expected


def with_time_features(frame: pd.DataFrame) -> pd.DataFrame:
    hours = frame.index.hour + frame.index.minute / 60
    out = frame.copy()
    out["hour_sin"] = np.sin(2 * np.pi * hours / 24)
    out["hour_cos"] = np.cos(2 * np.pi * hours / 24)
    return out


def train():
    history = {name: query_range(expr, HISTORY_DAYS) for name, (expr, _) in SIGNALS.items()}

    baselines = {}
    for name, (_, floor) in SIGNALS.items():
        for service, series in history[name].items():
            if len(series) >= MIN_POINTS:
                baselines[(service, name)] = SeasonalBaseline(series, floor)

    forests = {}
    services = set().union(*(h.keys() for h in history.values()))
    for service in services:
        if not all(service in history[name] for name in SIGNALS):
            continue
        frame = pd.concat({name: history[name][service] for name in SIGNALS}, axis=1).dropna()
        if len(frame) >= MIN_POINTS:
            forests[service] = IsolationForest(n_estimators=200, contamination=0.01, random_state=42).fit(
                with_time_features(frame)
            )

    trained_at.set_to_current_time()
    log.info("trained %d baselines and %d forests", len(baselines), len(forests))
    return baselines, forests


def score(baselines, forests):
    now = pd.Timestamp.now(tz="UTC")
    current = {name: query_now(expr) for name, (expr, _) in SIGNALS.items()}

    for (service, name), baseline in baselines.items():
        value = current[name].get(service)
        if value is None or np.isnan(value):
            continue
        z, expected = baseline.score(value, now)
        if z is not None:
            anomaly_score.labels(service, name).set(round(z, 2))
            baseline_value.labels(service, name).set(expected)

    for service, forest in forests.items():
        values = {name: current[name].get(service) for name in SIGNALS}
        if any(v is None or np.isnan(v) for v in values.values()):
            continue
        row = with_time_features(pd.DataFrame([values], index=pd.DatetimeIndex([now])))
        # decision_function < 0 means "outlier"; flip the sign so higher = more unusual
        outlier_score.labels(service).set(round(float(-forest.decision_function(row)[0]), 3))


if __name__ == "__main__":
    start_http_server(9105)
    baselines, forests, last_train = {}, {}, 0.0
    while True:
        try:
            if time.time() - last_train > RETRAIN_SECONDS:
                baselines, forests = train()
                last_train = time.time()
            score(baselines, forests)
        except Exception:
            log.exception("cycle failed; retrying next cycle")
        time.sleep(SCORE_SECONDS)
```

Create `monitoring/anomaly-detector/requirements.txt`:

```
numpy
pandas
scikit-learn
requests
prometheus-client
```

> For repeatable builds, pin exact versions once it works: run `pip freeze` inside the built image and copy the versions into `requirements.txt`.

Create `monitoring/anomaly-detector/Dockerfile`:

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
USER 1000
EXPOSE 9105
CMD ["python", "app.py"]
```

**Why these choices.**

- **Median + MAD per hour** is a seasonal baseline: 120 req/s at 8 p.m. is normal; at 4 a.m. it is not. It needs no labelled data, which you do not have.
- **Isolation Forest** catches cases where no single signal is extreme, but the combination is new, for example normal traffic with slightly higher latency *and* slightly more errors.
- Training on the recording rules (not raw histograms) keeps Prometheus queries cheap.
- If you later want a stronger forecasting-based detector, replace `SeasonalBaseline` with Prophet or a Holt-Winters model (as in Step 23) and score the forecast residual.

**Checkpoint:** the three files exist in `monitoring/anomaly-detector/`.

---

## 18. Step 15: Deploy the anomaly detector

1. Create the ECR repository, then build and push the image:

   ```bash
   aws ecr create-repository --repository-name blog-anomaly-detector --region $AWS_REGION
   aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_REGISTRY
   docker build -t $ECR_REGISTRY/blog-anomaly-detector:latest monitoring/anomaly-detector
   docker push $ECR_REGISTRY/blog-anomaly-detector:latest
   ```

2. Create `monitoring/anomaly-detector/k8s.yaml`:

   ```yaml
   apiVersion: apps/v1
   kind: Deployment
   metadata:
     name: anomaly-detector
     namespace: monitoring
   spec:
     replicas: 1
     selector:
       matchLabels:
         app: anomaly-detector
     template:
       metadata:
         labels:
           app: anomaly-detector
       spec:
         containers:
           - name: anomaly-detector
             image: <ECR_REGISTRY>/blog-anomaly-detector:latest
             ports:
               - name: metrics
                 containerPort: 9105
             env:
               - name: PROMETHEUS_URL
                 value: http://kps-prometheus.monitoring.svc:9090
               - name: HISTORY_DAYS
                 value: "21"
             resources:
               requests:
                 cpu: 50m
                 memory: 256Mi
               limits:
                 cpu: 500m
                 memory: 768Mi
   ---
   apiVersion: v1
   kind: Service
   metadata:
     name: anomaly-detector
     namespace: monitoring
     labels:
       ai-monitoring: "true"
   spec:
     selector:
       app: anomaly-detector
     ports:
       - name: metrics
         port: 9105
         targetPort: 9105
   ```

3. Apply it with your registry filled in:

   ```bash
   sed "s|<ECR_REGISTRY>|$ECR_REGISTRY|" monitoring/anomaly-detector/k8s.yaml | kubectl apply -f -
   kubectl rollout status deployment/anomaly-detector -n monitoring
   kubectl logs -n monitoring deploy/anomaly-detector
   ```

   With less than a day of data the log says `trained 0 baselines and 0 forests`. That is expected; the next hourly retrain picks up new data.

**Checkpoint:** after 1 day of data, the log shows `trained 9 baselines and 3 forests`, the Prometheus target `serviceMonitor/monitoring/ai-monitoring/0` is UP, and the query `ai_anomaly_score` returns 9 series (3 services × 3 signals).

---

## 19. Step 16: Alert on the anomaly scores

Create `monitoring/rules/ai-anomaly-alerts.yaml`:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: blog-ai-anomaly-alerts
  namespace: monitoring
spec:
  groups:
    - name: blog.ai-anomaly
      rules:
        # Traffic counts both ways (spike or sudden drop); errors and latency only upwards.
        - alert: AIAnomalyDetected
          expr: |
            ai_anomaly_score{signal="traffic"} > 4
            or ai_anomaly_score{signal="traffic"} < -4
            or ai_anomaly_score{signal=~"errors|latency_p95"} > 4
          for: 10m
          labels:
            severity: warning
            detector: ml
          annotations:
            summary: "AI detected unusual {{ $labels.signal }} on {{ $labels.service }}"
            description: "{{ $labels.signal }} on {{ $labels.service }} is {{ $value | printf \"%.1f\" }} spreads away from its normal value for this hour."

        - alert: AIMultiSignalAnomaly
          expr: ai_anomaly_outlier_score > 0
          for: 15m
          labels:
            severity: warning
            detector: ml
          annotations:
            summary: "Unusual combination of traffic, errors and latency on {{ $labels.service }}"
            description: "Isolation Forest score {{ $value | printf \"%.3f\" }}: this combination is rarer than 99% of the last weeks."

        - alert: AIAnomalyDetectorStale
          expr: time() - ai_anomaly_model_trained_timestamp_seconds > 3 * 3600
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "The anomaly detector has not retrained for 3 hours"
            description: "Check: kubectl logs -n monitoring deploy/anomaly-detector"
```

```bash
kubectl apply -f monitoring/rules/ai-anomaly-alerts.yaml
```

**Tune it.** After a week, look at how often each alert fired (**Alerts** in Prometheus, or the Alertmanager history in your inbox):

- Too many alerts: raise the threshold from 4 to 5, or `for:` from 10m to 20m.
- A known incident was missed: lower the threshold to 3.5.
- Once you trust the AI alerts, delete the static `BlogHighErrorRate` alert from Step 9 or keep it only as a `critical` backstop.

**Test it.** Make post-service slow for 15 minutes by flooding it from inside the cluster, then watch `ai_anomaly_score{service="post-service"}` in Prometheus:

```bash
kubectl run flood -n blog --image=busybox:1.36 --restart=Never -- /bin/sh -c \
  'end=$(( $(date +%s) + 900 )); while [ $(date +%s) -lt $end ]; do for i in $(seq 20); do wget -q -O /dev/null http://post-service:3002/api/posts & done; wait; done'
# afterwards
kubectl delete pod flood -n blog
```

**Checkpoint:** during the flood, `ai_anomaly_score{service="post-service",signal="traffic"}` rises above 4 and `AIAnomalyDetected` goes from pending to firing, and you receive the email.

---

# Part 3: Use case 2, AI alert summary and root cause

Today Alertmanager sends Gmail an email that says `KubePodCrashLooping` and little else. In this part, Alertmanager sends alerts to a small service, **alert-summarizer**, instead. For each alert group it:

1. Collects context: the pod's recent **logs** (including the previous crashed container), its **Kubernetes events**, and the service's **metrics** now and 1 hour ago.
2. **Redacts** secrets (database URLs, JWTs, passwords) from that text.
3. Sends it to **Claude** (Anthropic API) with instructions to write a summary, likely cause, evidence and next steps.
4. **Emails** the result through Gmail, with the original alert below it.
5. If Claude cannot be reached, it emails the plain alert so nothing is lost.

## 20. Step 17: Get an Anthropic API key and store the secrets

1. Sign in at https://console.anthropic.com/, add billing, and create an API key under **API Keys**.
2. Store it, the Gmail app password, and the addresses in a secret:

   ```bash
   kubectl create secret generic alert-summarizer -n monitoring \
     --from-literal=anthropic-api-key='<ANTHROPIC_API_KEY>' \
     --from-literal=gmail-app-password='<GMAIL_APP_PASSWORD>' \
     --from-literal=gmail-user="$GMAIL_USER" \
     --from-literal=alert-email-to="$ALERT_EMAIL_TO"
   ```

> **Data you send to the API.** Pod logs and events leave the cluster. The summarizer removes common secrets with regular expressions, but review what your services log before turning this on, and never log passwords or tokens in the first place.

**Checkpoint:** `kubectl get secret alert-summarizer -n monitoring` exists.

---

## 21. Step 18: Build the alert summarizer

Create `monitoring/alert-summarizer/app.py`:

```python
"""Alertmanager webhook -> collect logs, events and metrics -> Claude summary -> Gmail.

POST /alert   Alertmanager webhook (returns at once; work runs in the background)
GET  /healthz liveness and readiness probe
"""
import logging
import os
import re
import smtplib
from email.message import EmailMessage

import anthropic
import requests
from fastapi import BackgroundTasks, FastAPI, Request
from kubernetes import client as k8s, config as k8s_config

log = logging.getLogger("alert-summarizer")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

PROM = os.environ.get("PROMETHEUS_URL", "http://kps-prometheus.monitoring.svc:9090")
MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-5-5")
EFFORT = os.environ.get("CLAUDE_EFFORT", "medium")
GMAIL_USER = os.environ["GMAIL_USER"]
GMAIL_APP_PASSWORD = os.environ["GMAIL_APP_PASSWORD"]
ALERT_EMAIL_TO = os.environ["ALERT_EMAIL_TO"]
LOG_LINES = int(os.environ.get("LOG_LINES", "80"))

# Models that accept server-side refusal fallbacks on the Claude API.
FALLBACK_MODELS = {"claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"}

k8s_config.load_incluster_config()
core = k8s.CoreV1Api()
claude = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY
app = FastAPI()

SYSTEM_PROMPT = """You are the on-call SRE assistant for MySocialSpace, a blog platform on Amazon EKS
(region ap-south-1). Namespace "blog" runs auth-service (port 3001), post-service (3002) and
comment-service (3003), which are Node.js/Express services using Prisma with an RDS MySQL database,
plus a React frontend behind ingress-nginx with cert-manager certificates. Each deployment's pods
carry the label app=<deployment name>.

You receive one Prometheus alert group and the pod logs, Kubernetes events and metrics that were
collected when it fired. Write the body of an email to the engineer on call, in plain text with
these sections:

SUMMARY: two or three sentences in plain English: what is broken and since when.
LIKELY CAUSE: the most likely cause first, with how confident you are; other candidates after.
EVIDENCE: the specific log lines, events or metric values that support the cause.
NEXT STEPS: numbered actions, each with the exact kubectl or aws command to run.
IMPACT: which users or features are affected.

Base every statement on the data provided. If the data does not show the cause, say so plainly and
list what to check next. Keep it under 400 words."""

REDACTIONS = [
    (re.compile(r"\b(mysql|postgres(?:ql)?|mongodb(?:\+srv)?|redis)://\S+"), r"\1://[REDACTED]"),
    (re.compile(r"eyJ[\w-]+\.[\w-]+\.[\w-]+"), "[REDACTED_JWT]"),
    (re.compile(r"(?i)\b(password|passwd|pwd|secret|token|api[_-]?key)(\"?\s*[:=]\s*)\S+"), r"\1\2[REDACTED]"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "[REDACTED_AWS_KEY]"),
]


def redact(text: str) -> str:
    for pattern, replacement in REDACTIONS:
        text = pattern.sub(replacement, text)
    return text


# ---------------------------------------------------------------- context collection

def prom_query(expr: str) -> str:
    try:
        r = requests.get(f"{PROM}/api/v1/query", params={"query": expr}, timeout=10)
        r.raise_for_status()
        rows = []
        for s in r.json()["data"]["result"]:
            labels = {k: v for k, v in s["metric"].items() if k in ("pod", "service", "container")}
            rows.append(f"{labels or ''} {float(s['value'][1]):.4g}")
        return "; ".join(rows) or "no data"
    except Exception as e:  # never let one query break the summary
        return f"query failed: {e}"


def app_name(labels: dict) -> str | None:
    """Deployment name from the alert labels, e.g. post-service."""
    for key in ("deployment", "service"):
        if labels.get(key, "").endswith("-service"):
            return labels[key]
    pod = labels.get("pod")
    if pod and pod.count("-") >= 2:
        return pod.rsplit("-", 2)[0]  # post-service-7d9f8c6b5-x2x7z -> post-service
    return None


def find_pods(namespace: str, labels: dict) -> list[str]:
    if labels.get("pod"):
        return [labels["pod"]]
    name = app_name(labels)
    if not name:
        return []
    pods = core.list_namespaced_pod(namespace, label_selector=f"app={name}").items
    pods.sort(key=lambda p: p.metadata.creation_timestamp, reverse=True)
    return [p.metadata.name for p in pods[:2]]


def pod_logs(namespace: str, pod: str, container: str | None) -> str:
    # The previous container's logs explain a crash; fall back to the current one.
    for previous in (True, False):
        try:
            text = core.read_namespaced_pod_log(
                pod, namespace, container=container, tail_lines=LOG_LINES,
                previous=previous, timestamps=True,
            )
            if text:
                return ("(previous container)\n" if previous else "(current container)\n") + text
        except k8s.exceptions.ApiException:
            continue
    return "(no logs available)"


def pod_events(namespace: str, pod: str) -> str:
    events = core.list_namespaced_event(namespace, field_selector=f"involvedObject.name={pod}").items
    events.sort(key=lambda e: e.last_timestamp or e.event_time or e.metadata.creation_timestamp)
    return "\n".join(f"{e.type} {e.reason} (x{e.count or 1}): {e.message}" for e in events[-15:]) or "(no events)"


def service_metrics(namespace: str, svc: str) -> str:
    queries = {
        "requests/s now": f'service:http_requests:rate5m{{service="{svc}"}}',
        "requests/s 1h ago": f'service:http_requests:rate5m{{service="{svc}"}} offset 1h',
        "5xx ratio now": f'service:http_errors:ratio_rate5m{{service="{svc}"}}',
        "p95 latency s now": f'service:http_latency_p95:5m{{service="{svc}"}}',
        "p95 latency s 1h ago": f'service:http_latency_p95:5m{{service="{svc}"}} offset 1h',
        "anomaly scores": f'ai_anomaly_score{{service="{svc}"}}',
        "restarts in last 1h": f'sum by (pod) (increase(kube_pod_container_status_restarts_total{{namespace="{namespace}", pod=~"{svc}-.*"}}[1h]))',
        "memory used / limit": (
            f'sum by (pod) (container_memory_working_set_bytes{{namespace="{namespace}", pod=~"{svc}-.*", container!=""}})'
            f' / sum by (pod) (kube_pod_container_resource_limits{{namespace="{namespace}", pod=~"{svc}-.*", resource="memory"}})'
        ),
        "cpu used / limit": (
            f'sum by (pod) (rate(container_cpu_usage_seconds_total{{namespace="{namespace}", pod=~"{svc}-.*", container!=""}}[5m]))'
            f' / sum by (pod) (kube_pod_container_resource_limits{{namespace="{namespace}", pod=~"{svc}-.*", resource="cpu"}})'
        ),
        "ready replicas": f'kube_deployment_status_replicas_ready{{namespace="{namespace}", deployment="{svc}"}}',
    }
    return "\n".join(f"- {name}: {prom_query(q)}" for name, q in queries.items())


def build_context(payload: dict) -> str:
    parts = [f"Alert group status: {payload.get('status')}", f"Common labels: {payload.get('commonLabels')}"]
    seen_pods, seen_services = set(), set()
    for alert in payload.get("alerts", [])[:5]:
        labels, annotations = alert.get("labels", {}), alert.get("annotations", {})
        parts.append(
            f"\n## Alert {labels.get('alertname')} (severity {labels.get('severity', 'none')}), started {alert.get('startsAt')}\n"
            f"Labels: {labels}\n"
            f"Description: {annotations.get('description') or annotations.get('summary') or annotations.get('message') or ''}"
        )
        namespace = labels.get("namespace")
        if not namespace:
            continue
        for pod in find_pods(namespace, labels):
            if (namespace, pod) in seen_pods:
                continue
            seen_pods.add((namespace, pod))
            parts.append(f"\n### Kubernetes events for {namespace}/{pod}\n{pod_events(namespace, pod)}")
            parts.append(f"\n### Last {LOG_LINES} log lines of {namespace}/{pod}\n{pod_logs(namespace, pod, labels.get('container'))}")
        svc = app_name(labels)
        if svc and svc not in seen_services:
            seen_services.add(svc)
            parts.append(f"\n### Metrics for {svc}\n{service_metrics(namespace, svc)}")
    return redact("\n".join(parts))


# ---------------------------------------------------------------- Claude and email

def summarize(context: str) -> str | None:
    extra = {}
    if MODEL in FALLBACK_MODELS:
        # If a safety classifier declines, the API retries on a recommended model in the same call.
        extra = {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}
    response = claude.beta.messages.create(
        model=MODEL,
        max_tokens=16000,
        output_config={"effort": EFFORT},
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": context}],
        **extra,
    )
    if response.stop_reason == "refusal":
        log.warning("model declined to summarize this alert")
        return None
    text = "".join(block.text for block in response.content if block.type == "text").strip()
    log.info("summary done: %s input / %s output tokens", response.usage.input_tokens, response.usage.output_tokens)
    return text or None


def raw_alert_text(payload: dict) -> str:
    lines = []
    for a in payload.get("alerts", []):
        lines.append(f"[{a.get('status', '').upper()}] {a.get('labels', {}).get('alertname')}")
        lines += [f"  {k} = {v}" for k, v in sorted(a.get("labels", {}).items())]
        lines += [f"  {k}: {v}" for k, v in a.get("annotations", {}).items()]
        lines.append(f"  started: {a.get('startsAt')}\n")
    return "\n".join(lines)


def send_email(subject: str, body: str) -> None:
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = subject, GMAIL_USER, ALERT_EMAIL_TO
    msg.set_content(body)
    with smtplib.SMTP("smtp.gmail.com", 587, timeout=30) as smtp:
        smtp.starttls()
        smtp.login(GMAIL_USER, GMAIL_APP_PASSWORD)
        smtp.send_message(msg)


def handle(payload: dict) -> None:
    labels = payload.get("commonLabels", {})
    target = labels.get("service") or labels.get("deployment") or labels.get("pod") or ""
    subject = f"[{payload.get('status', 'firing').upper()}] {labels.get('alertname', 'Alert')} {labels.get('namespace', '')} {target}".strip()

    summary = None
    try:
        summary = summarize(build_context(payload))
    except anthropic.APIConnectionError as e:
        log.error("cannot reach the Claude API: %s", e)
    except anthropic.APIStatusError as e:
        log.error("Claude API error %s: %s", e.status_code, e.message)
    except Exception:
        log.exception("could not build the summary")

    raw = raw_alert_text(payload)
    if summary:
        body = f"AI SUMMARY ({MODEL})\n{'=' * 60}\n{summary}\n\n{'=' * 60}\nORIGINAL ALERT\n\n{raw}"
        subject += " | AI summary"
    else:
        body = f"The AI summary is not available for this alert. Original alert:\n\n{raw}"
    send_email(subject, body)
    log.info("emailed: %s", subject)


@app.post("/alert")
async def alert(request: Request, background: BackgroundTasks):
    payload = await request.json()
    background.add_task(handle, payload)  # answer Alertmanager at once
    return {"status": "accepted"}


@app.get("/healthz")
def healthz():
    return {"status": "ok"}
```

Create `monitoring/alert-summarizer/requirements.txt`:

```
anthropic
fastapi
uvicorn
kubernetes
requests
```

Create `monitoring/alert-summarizer/Dockerfile`:

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
USER 1000
EXPOSE 8080
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
```

**Design notes.**

- **Model.** The default is `claude-opus-5-5` at `medium` effort, which gives careful root-cause reasoning. To cut cost, set the `CLAUDE_MODEL` environment variable to `claude-sonnet-5-5` or `claude-haiku-5-5`. You can change it without rebuilding the image.
- **Refusal fallback.** On models that support it, the request opts into `fallbacks: "default"`, so if a safety classifier declines (for example, because a log line looks like attack traffic), the API retries on another model in the same call. If everything declines, the plain alert is still emailed.
- **Returns at once.** Alertmanager waits only about 10 seconds for a webhook. The work runs in a background task.
- **Read-only.** The service can read pods, logs and events. It cannot change anything in the cluster. Claude suggests commands; a person runs them.

**Checkpoint:** the three files exist in `monitoring/alert-summarizer/`.

---

## 22. Step 19: Deploy the alert summarizer

1. Build and push:

   ```bash
   aws ecr create-repository --repository-name blog-alert-summarizer --region $AWS_REGION
   docker build -t $ECR_REGISTRY/blog-alert-summarizer:latest monitoring/alert-summarizer
   docker push $ECR_REGISTRY/blog-alert-summarizer:latest
   ```

2. Create `monitoring/alert-summarizer/k8s.yaml`:

   ```yaml
   apiVersion: v1
   kind: ServiceAccount
   metadata:
     name: alert-summarizer
     namespace: monitoring
   ---
   # Read-only access to pods, logs and events in every namespace
   apiVersion: rbac.authorization.k8s.io/v1
   kind: ClusterRole
   metadata:
     name: alert-summarizer-read
   rules:
     - apiGroups: [""]
       resources: ["pods", "pods/log", "events"]
       verbs: ["get", "list"]
   ---
   apiVersion: rbac.authorization.k8s.io/v1
   kind: ClusterRoleBinding
   metadata:
     name: alert-summarizer-read
   roleRef:
     apiGroup: rbac.authorization.k8s.io
     kind: ClusterRole
     name: alert-summarizer-read
   subjects:
     - kind: ServiceAccount
       name: alert-summarizer
       namespace: monitoring
   ---
   apiVersion: apps/v1
   kind: Deployment
   metadata:
     name: alert-summarizer
     namespace: monitoring
   spec:
     replicas: 1
     selector:
       matchLabels:
         app: alert-summarizer
     template:
       metadata:
         labels:
           app: alert-summarizer
       spec:
         serviceAccountName: alert-summarizer
         containers:
           - name: alert-summarizer
             image: <ECR_REGISTRY>/blog-alert-summarizer:latest
             ports:
               - name: http
                 containerPort: 8080
             env:
               - name: PROMETHEUS_URL
                 value: http://kps-prometheus.monitoring.svc:9090
               - name: CLAUDE_MODEL
                 value: claude-opus-5-5
               - name: CLAUDE_EFFORT
                 value: medium
               - name: ANTHROPIC_API_KEY
                 valueFrom:
                   secretKeyRef: { name: alert-summarizer, key: anthropic-api-key }
               - name: GMAIL_APP_PASSWORD
                 valueFrom:
                   secretKeyRef: { name: alert-summarizer, key: gmail-app-password }
               - name: GMAIL_USER
                 valueFrom:
                   secretKeyRef: { name: alert-summarizer, key: gmail-user }
               - name: ALERT_EMAIL_TO
                 valueFrom:
                   secretKeyRef: { name: alert-summarizer, key: alert-email-to }
             readinessProbe:
               httpGet: { path: /healthz, port: 8080 }
               periodSeconds: 10
             livenessProbe:
               httpGet: { path: /healthz, port: 8080 }
               initialDelaySeconds: 10
               periodSeconds: 20
             resources:
               requests:
                 cpu: 20m
                 memory: 128Mi
               limits:
                 cpu: 300m
                 memory: 256Mi
   ---
   apiVersion: v1
   kind: Service
   metadata:
     name: alert-summarizer
     namespace: monitoring
   spec:
     selector:
       app: alert-summarizer
     ports:
       - name: http
         port: 8080
         targetPort: 8080
   ```

3. Apply:

   ```bash
   sed "s|<ECR_REGISTRY>|$ECR_REGISTRY|" monitoring/alert-summarizer/k8s.yaml | kubectl apply -f -
   kubectl rollout status deployment/alert-summarizer -n monitoring
   ```

4. Send it a test alert directly, before involving Alertmanager:

   ```bash
   kubectl run curl-test -n monitoring --rm -i --restart=Never --image=curlimages/curl:8.10.1 -- \
     curl -s -XPOST http://alert-summarizer:8080/alert -H 'Content-Type: application/json' -d '{
       "status": "firing",
       "commonLabels": {"alertname": "TestAlert", "namespace": "blog", "service": "post-service"},
       "alerts": [{"status": "firing", "startsAt": "2026-10-17T10:00:00Z",
                   "labels": {"alertname": "TestAlert", "severity": "warning", "namespace": "blog", "service": "post-service"},
                   "annotations": {"description": "Manual test of the AI summarizer"}}]}'
   kubectl logs -n monitoring deploy/alert-summarizer -f
   ```

**Checkpoint:** the log shows `summary done: ... tokens` and `emailed: [FIRING] TestAlert blog post-service | AI summary`, and the email contains SUMMARY, LIKELY CAUSE, EVIDENCE, NEXT STEPS and IMPACT sections based on the real metrics of post-service.

---

## 23. Step 20: Route Alertmanager through the summarizer

Change the `alertmanager.config` section of `monitoring/kube-prometheus-stack-values.yaml` so that alerts go to the summarizer, while two cases still go straight to Gmail: the summarizer itself being down, and anything the summarizer cannot handle.

```yaml
  config:
    global:
      smtp_smarthost: smtp.gmail.com:587
      smtp_from: <GMAIL_USER>
      smtp_auth_username: <GMAIL_USER>
      smtp_require_tls: true
    route:
      receiver: ai-summarizer
      group_by: [alertname, namespace, service]
      group_wait: 30s
      group_interval: 5m
      repeat_interval: 4h
      routes:
        - receiver: "null"
          matchers:
            - alertname =~ "Watchdog|InfoInhibitor"
        # If the summarizer is down, it cannot report itself: email directly.
        - receiver: email
          matchers:
            - alertname = "AlertSummarizerDown"
    receivers:
      - name: "null"
      - name: email
        email_configs:
          - to: <ALERT_EMAIL_TO>
            auth_password_file: /etc/alertmanager/secrets/alertmanager-gmail/password
            send_resolved: true
      - name: ai-summarizer
        webhook_configs:
          - url: http://alert-summarizer.monitoring.svc:8080/alert
            send_resolved: false   # resolved notices do not need an AI summary
            max_alerts: 10
```

Apply it (use the same `<KPS_VERSION>` as before):

```bash
helm upgrade kps prometheus-community/kube-prometheus-stack -n monitoring \
  --version <KPS_VERSION> -f monitoring/kube-prometheus-stack-values.yaml --wait
```

Add the watchdog alert for the summarizer to `monitoring/rules/golden-signals.yaml`, under the `blog.basic-alerts` rules, and re-apply the file:

```yaml
        - alert: AlertSummarizerDown
          expr: kube_deployment_status_replicas_available{namespace="monitoring", deployment="alert-summarizer"} < 1
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "alert-summarizer is down: alerts are not being emailed"
            description: "Check: kubectl describe deploy/alert-summarizer -n monitoring"
```

```bash
kubectl apply -f monitoring/rules/golden-signals.yaml
```

Check the active configuration at http://localhost:9093/#/status (port-forward from Step 6).

**Checkpoint:** the Alertmanager status page shows `receiver: ai-summarizer` as the default route.

---

## 24. Step 21: Test with a crash-looping pod

Start a pod that crashes with a database-style error, the way a misconfigured service would:

```bash
kubectl run crash-demo -n blog --image=busybox:1.36 --restart=Always -- /bin/sh -c \
  'echo "Starting post-service..."; echo "PrismaClientInitializationError: Cannot reach database server at blog-db.xxxx.ap-south-1.rds.amazonaws.com:3306"; echo "Please make sure your database server is running"; exit 1'
```

The built-in `KubePodCrashLooping` alert fires after about 15 minutes. Then:

```bash
kubectl logs -n monitoring deploy/alert-summarizer --tail=20
```

Expected email (wording will differ):

```
Subject: [FIRING] KubePodCrashLooping blog crash-demo | AI summary

AI SUMMARY (claude-opus-5-5)
============================================================
SUMMARY: Pod blog/crash-demo has restarted 6 times in the last 15 minutes and is in
CrashLoopBackOff. Each start fails within a second.

LIKELY CAUSE (high confidence): the process cannot reach the database. The previous
container's log ends with "PrismaClientInitializationError: Cannot reach database server
at ...:3306" and the process exits with code 1. ...

EVIDENCE:
- Log: "Cannot reach database server at blog-db...:3306"
- Event: Warning BackOff (x9): Back-off restarting failed container
...

NEXT STEPS:
1. Confirm the RDS instance is available:
   aws rds describe-db-instances --region ap-south-1 --query "DBInstances[].DBInstanceStatus"
2. Test the connection from inside the cluster: ...
3. Check the RDS security group allows 3306 from the node security group ...

IMPACT: ...
============================================================
ORIGINAL ALERT
...
```

Clean up:

```bash
kubectl delete pod crash-demo -n blog
```

**Checkpoint:** you received an email with an AI summary that names the database connection as the cause and quotes the log line.

---

# Part 4: Use case 3, predictive capacity and scaling

The HPA scales on CPU, so it acts only after load arrives, and new pods need 20 to 30 seconds to become ready. This part adds:

1. **Early warnings with `predict_linear`** (Step 22) for disks, memory and cluster capacity. Works right away.
2. **A traffic forecaster** (Step 23) that learns daily patterns with Holt-Winters and predicts peak traffic for the next 15 minutes to 7 days.
3. **KEDA** (Step 24) to scale pods on the forecast *and* CPU, whichever asks for more.
4. **Karpenter with placeholder pods** (Step 25) to add nodes before the extra pods need them.

## 25. Step 22: Add predict_linear early-warning alerts

`predict_linear(series[window], seconds)` fits a straight line through the window and predicts the value `seconds` ahead. kube-prometheus-stack already uses it for `NodeFilesystemSpaceFillingUp` (node disks) and `KubePersistentVolumeFillingUp` (PVCs such as Prometheus's own). This step adds the cases it does not cover.

Create `monitoring/rules/capacity-rules.yaml`:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: blog-capacity
  namespace: monitoring
spec:
  groups:
    - name: blog.capacity-early-warning
      rules:
        # A container's memory keeps growing (for example a leak) and will
        # reach its limit within 24 hours, which means an OOMKill.
        - alert: ContainerMemoryWillHitLimit
          expr: |
            predict_linear(container_memory_working_set_bytes{namespace="blog", container!=""}[6h], 24 * 3600)
              > on(namespace, pod, container)
            max by (namespace, pod, container) (kube_pod_container_resource_limits{namespace="blog", resource="memory"})
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "{{ $labels.pod }} will run out of memory within 24 hours"
            description: "Memory of {{ $labels.container }} grows steadily and will reach its limit. Look for a leak or raise the limit."

        - alert: NodeMemoryWillBeExhausted
          expr: predict_linear(node_memory_MemAvailable_bytes[12h], 2 * 24 * 3600) < 0
          for: 1h
          labels:
            severity: warning
          annotations:
            summary: "Node {{ $labels.instance }} will run out of memory within 2 days"
            description: "Available memory is falling steadily."

        # Requested CPU of running pods keeps growing and will be more than the
        # nodes can give within 3 days: new pods will stay Pending.
        - alert: ClusterCPURequestsWillExceedCapacity
          expr: |
            predict_linear(
              sum(
                kube_pod_container_resource_requests{resource="cpu"}
                * on(namespace, pod) group_left()
                max by (namespace, pod) (kube_pod_status_phase{phase=~"Pending|Running"} == 1)
              )[2d:10m],
              3 * 24 * 3600
            )
            > sum(kube_node_status_allocatable{resource="cpu"})
          for: 1h
          labels:
            severity: warning
          annotations:
            summary: "Cluster CPU requests will exceed node capacity within 3 days"
            description: "Add nodes or let Karpenter add them (Step 25)."

        - alert: ClusterMemoryRequestsWillExceedCapacity
          expr: |
            predict_linear(
              sum(
                kube_pod_container_resource_requests{resource="memory"}
                * on(namespace, pod) group_left()
                max by (namespace, pod) (kube_pod_status_phase{phase=~"Pending|Running"} == 1)
              )[2d:10m],
              3 * 24 * 3600
            )
            > sum(kube_node_status_allocatable{resource="memory"})
          for: 1h
          labels:
            severity: warning
          annotations:
            summary: "Cluster memory requests will exceed node capacity within 3 days"
            description: "Add nodes or let Karpenter add them (Step 25)."
```

```bash
kubectl apply -f monitoring/rules/capacity-rules.yaml
```

**Checkpoint:** **Status → Rules** in Prometheus shows `blog.capacity-early-warning` with state OK.

---

## 26. Step 23: Build and deploy the capacity forecaster

The forecaster:

1. **Every hour:** reads up to 14 days of `service:http_requests:rate5m` per service and fits a **Holt-Winters** (triple exponential smoothing) model with a daily season, then forecasts the next 7 days in 5-minute steps.
2. **Every minute:** publishes, for horizons of 15 minutes, 1 hour, 24 hours and 7 days:
   - `ai_forecast_requests_per_second{service, horizon}`: forecast **peak** request rate in that window.
   - `ai_forecast_replicas_needed{service, horizon}`: replicas needed for that peak, with 20% headroom.
   - `ai_forecast_capacity_rps{service}`: the request rate the service can serve at its maximum replicas.

**First, measure what one pod can handle.** The forecaster needs the request rate one pod can serve while staying under the 70% CPU target. A quick way:

```bash
kubectl scale deployment/post-service -n blog --replicas=1     # temporarily; the HPA will scale it back
kubectl run hey -n blog --rm -i --restart=Never --image=williamyeh/hey -- \
  -z 2m -c 20 http://post-service:3002/api/posts
# while it runs, in another terminal:
kubectl top pod -n blog -l app=post-service
```

Lower or raise `-c` until the pod sits at about 70% of its CPU request-based target, and note the "Requests/sec" from `hey`. Repeat for the other services. If you skip this, the defaults below are conservative guesses for a t3.medium.

Create `monitoring/capacity-forecaster/app.py`:

```python
"""Forecasts request rate per service with Holt-Winters and exports capacity metrics on :9106/metrics.

  ai_forecast_requests_per_second{service, horizon}  forecast peak req/s in the next <horizon>
  ai_forecast_replicas_needed{service, horizon}      replicas needed for that peak (with headroom)
  ai_forecast_capacity_rps{service}                  req/s the service can serve at max replicas
"""
import json
import logging
import math
import os
import time
import warnings
from datetime import datetime, timedelta, timezone

import pandas as pd
import requests
from prometheus_client import Gauge, start_http_server
from statsmodels.tsa.holtwinters import ExponentialSmoothing

warnings.filterwarnings("ignore")  # statsmodels convergence warnings are noisy and harmless here
log = logging.getLogger("capacity-forecaster")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

PROM = os.environ.get("PROMETHEUS_URL", "http://kps-prometheus.monitoring.svc:9090")
HISTORY_DAYS = int(os.environ.get("HISTORY_DAYS", "14"))
RETRAIN_SECONDS = int(os.environ.get("RETRAIN_SECONDS", "3600"))
# Requests/second one pod serves at the 70% CPU target (measure with a load test).
POD_CAPACITY_RPS = json.loads(os.environ.get(
    "POD_CAPACITY_RPS", '{"auth-service": 20, "post-service": 30, "comment-service": 30}'))
MIN_REPLICAS = int(os.environ.get("MIN_REPLICAS", "2"))
MAX_REPLICAS = int(os.environ.get("MAX_REPLICAS", "5"))
HEADROOM = float(os.environ.get("HEADROOM", "1.2"))

SEASON = 288                 # 5-minute steps per day
FORECAST_STEPS = 7 * SEASON  # 7 days ahead
HORIZONS = {"15m": timedelta(minutes=15), "1h": timedelta(hours=1), "24h": timedelta(days=1), "7d": timedelta(days=7)}

forecast_rps = Gauge("ai_forecast_requests_per_second", "Forecast peak request rate in the coming window", ["service", "horizon"])
replicas_needed = Gauge("ai_forecast_replicas_needed", "Replicas needed for the forecast peak, with headroom", ["service", "horizon"])
capacity_rps = Gauge("ai_forecast_capacity_rps", "Request rate the service can serve at max replicas", ["service"])
trained_at = Gauge("ai_forecast_model_trained_timestamp_seconds", "When the forecast was last computed", ["service"])

forecasts: dict[str, pd.Series] = {}


def query_range(expr: str) -> dict[str, pd.Series]:
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=HISTORY_DAYS)
    r = requests.get(
        f"{PROM}/api/v1/query_range",
        params={"query": expr, "start": start.timestamp(), "end": end.timestamp(), "step": "5m"},
        timeout=120,
    )
    r.raise_for_status()
    out = {}
    for s in r.json()["data"]["result"]:
        index = pd.to_datetime([float(t) for t, _ in s["values"]], unit="s", utc=True)
        values = pd.to_numeric([v for _, v in s["values"]], errors="coerce")
        out[s["metric"].get("service", "unknown")] = pd.Series(values, index=index)
    return out


def train() -> None:
    for service, series in query_range("service:http_requests:rate5m").items():
        # Regular 5-minute grid; fill short gaps (pod restarts), treat long gaps as no traffic.
        y = series.resample("5min").mean().interpolate(limit=6).fillna(0)
        if len(y) < 2 * SEASON:
            log.info("%s: %d points, need %d (2 days) before forecasting", service, len(y), 2 * SEASON)
            continue
        model = ExponentialSmoothing(
            y, trend="add", damped_trend=True, seasonal="add",
            seasonal_periods=SEASON, initialization_method="estimated",
        ).fit()
        forecasts[service] = model.forecast(FORECAST_STEPS).clip(lower=0)
        trained_at.labels(service).set_to_current_time()
        log.info("%s: forecast 7-day peak %.2f req/s", service, forecasts[service].max())


def publish() -> None:
    now = pd.Timestamp.now(tz="UTC")
    for service, forecast in forecasts.items():
        per_pod = POD_CAPACITY_RPS.get(service)
        if per_pod:
            capacity_rps.labels(service).set(per_pod * MAX_REPLICAS)
        for horizon, delta in HORIZONS.items():
            window = forecast[(forecast.index > now) & (forecast.index <= now + delta)]
            if window.empty:
                continue
            peak = float(window.max())
            forecast_rps.labels(service, horizon).set(round(peak, 3))
            if per_pod:
                needed = math.ceil(peak * HEADROOM / per_pod)
                replicas_needed.labels(service, horizon).set(min(MAX_REPLICAS, max(MIN_REPLICAS, needed)))


if __name__ == "__main__":
    start_http_server(9106)
    last_train = 0.0
    while True:
        try:
            if time.time() - last_train > RETRAIN_SECONDS:
                train()
                last_train = time.time()
            publish()
        except Exception:
            log.exception("cycle failed; retrying next cycle")
        time.sleep(60)
```

Create `monitoring/capacity-forecaster/requirements.txt`:

```
pandas
statsmodels
requests
prometheus-client
```

Create `monitoring/capacity-forecaster/Dockerfile`:

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
USER 1000
EXPOSE 9106
CMD ["python", "app.py"]
```

Create `monitoring/capacity-forecaster/k8s.yaml`. Put your measured numbers into `POD_CAPACITY_RPS`, and keep `MIN_REPLICAS`/`MAX_REPLICAS` the same as the scaling limits in Step 24:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: capacity-forecaster
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: capacity-forecaster
  template:
    metadata:
      labels:
        app: capacity-forecaster
    spec:
      containers:
        - name: capacity-forecaster
          image: <ECR_REGISTRY>/blog-capacity-forecaster:latest
          ports:
            - name: metrics
              containerPort: 9106
          env:
            - name: PROMETHEUS_URL
              value: http://kps-prometheus.monitoring.svc:9090
            - name: POD_CAPACITY_RPS
              value: '{"auth-service": 20, "post-service": 30, "comment-service": 30}'
            - name: MIN_REPLICAS
              value: "2"
            - name: MAX_REPLICAS
              value: "5"
          resources:
            requests:
              cpu: 50m
              memory: 256Mi
            limits:
              cpu: "1"
              memory: 768Mi
---
apiVersion: v1
kind: Service
metadata:
  name: capacity-forecaster
  namespace: monitoring
  labels:
    ai-monitoring: "true"
spec:
  selector:
    app: capacity-forecaster
  ports:
    - name: metrics
      port: 9106
      targetPort: 9106
```

Build, push and deploy:

```bash
aws ecr create-repository --repository-name blog-capacity-forecaster --region $AWS_REGION
docker build -t $ECR_REGISTRY/blog-capacity-forecaster:latest monitoring/capacity-forecaster
docker push $ECR_REGISTRY/blog-capacity-forecaster:latest
sed "s|<ECR_REGISTRY>|$ECR_REGISTRY|" monitoring/capacity-forecaster/k8s.yaml | kubectl apply -f -
kubectl logs -n monitoring deploy/capacity-forecaster -f
```

Add the "warn days ahead" alerts to `monitoring/rules/capacity-rules.yaml` as a second group, and re-apply:

```yaml
    - name: blog.capacity-forecast
      rules:
        # Within 7 days, forecast traffic is more than the service can take even at max replicas.
        - alert: ForecastTrafficExceedsCapacity
          expr: ai_forecast_requests_per_second{horizon="7d"} > on(service) ai_forecast_capacity_rps
          for: 1h
          labels:
            severity: warning
          annotations:
            summary: "{{ $labels.service }} is forecast to exceed its capacity within 7 days"
            description: "Forecast peak {{ $value | printf \"%.1f\" }} req/s is more than max replicas can serve. Raise maxReplicaCount, add nodes, or optimise the service."

        - alert: ForecastNeedsMaxReplicasTomorrow
          expr: ai_forecast_replicas_needed{horizon="24h"} >= 5
          for: 1h
          labels:
            severity: info
          annotations:
            summary: "{{ $labels.service }} is forecast to need its maximum replicas within 24 hours"
            description: "Check node capacity before the peak."

        - alert: CapacityForecasterStale
          expr: time() - ai_forecast_model_trained_timestamp_seconds > 3 * 3600
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "The capacity forecast for {{ $labels.service }} has not updated for 3 hours"
            description: "Check: kubectl logs -n monitoring deploy/capacity-forecaster"
```

```bash
kubectl apply -f monitoring/rules/capacity-rules.yaml
```

**Checkpoint:** after 2 days of data, the log shows `forecast 7-day peak ...` for each service, and in Prometheus `ai_forecast_replicas_needed{horizon="15m"}` returns 3 series.

---

## 27. Step 24: Pre-scale pods with KEDA

[KEDA](https://keda.sh/) lets a deployment scale on any Prometheus query. You replace each HPA with a KEDA **ScaledObject** that has two triggers. Kubernetes uses whichever asks for more replicas:

- **CPU at 70%** (the same as today's HPA): reacts to load that the forecast did not see coming.
- **`ai_forecast_replicas_needed{horizon="15m"}`**: adds pods up to 15 minutes before a predicted peak.

1. Install KEDA:

   ```bash
   helm repo add kedacore https://kedacore.github.io/charts
   helm repo update
   helm upgrade --install keda kedacore/keda --namespace keda --create-namespace --wait
   ```

2. Delete the existing HPAs. KEDA creates its own HPA, and two HPAs on one deployment fight each other:

   ```bash
   kubectl delete hpa auth-service-hpa post-service-hpa comment-service-hpa -n blog
   ```

   Also move `k8s/*/hpa.yaml` out of the way (for example rename them to `hpa.yaml.disabled`) so nobody re-applies them.

3. Create `monitoring/keda/scaledobjects.yaml`:

   ```yaml
   apiVersion: keda.sh/v1alpha1
   kind: ScaledObject
   metadata:
     name: auth-service
     namespace: blog
   spec:
     scaleTargetRef:
       name: auth-service
     minReplicaCount: 2
     maxReplicaCount: 5
     advanced:
       horizontalPodAutoscalerConfig:
         behavior:
           scaleDown:
             stabilizationWindowSeconds: 600   # keep pre-scaled pods through the peak
     triggers:
       - type: cpu
         metricType: Utilization
         metadata:
           value: "70"
       - type: prometheus
         metadata:
           serverAddress: http://kps-prometheus.monitoring.svc:9090
           query: max(ai_forecast_replicas_needed{service="auth-service", horizon="15m"})
           threshold: "1"            # value is already a replica count
           ignoreNullValues: "true"  # no forecast yet = this trigger asks for nothing
   ---
   apiVersion: keda.sh/v1alpha1
   kind: ScaledObject
   metadata:
     name: post-service
     namespace: blog
   spec:
     scaleTargetRef:
       name: post-service
     minReplicaCount: 2
     maxReplicaCount: 5
     advanced:
       horizontalPodAutoscalerConfig:
         behavior:
           scaleDown:
             stabilizationWindowSeconds: 600
     triggers:
       - type: cpu
         metricType: Utilization
         metadata:
           value: "70"
       - type: prometheus
         metadata:
           serverAddress: http://kps-prometheus.monitoring.svc:9090
           query: max(ai_forecast_replicas_needed{service="post-service", horizon="15m"})
           threshold: "1"
           ignoreNullValues: "true"
   ---
   apiVersion: keda.sh/v1alpha1
   kind: ScaledObject
   metadata:
     name: comment-service
     namespace: blog
   spec:
     scaleTargetRef:
       name: comment-service
     minReplicaCount: 2
     maxReplicaCount: 5
     advanced:
       horizontalPodAutoscalerConfig:
         behavior:
           scaleDown:
             stabilizationWindowSeconds: 600
     triggers:
       - type: cpu
         metricType: Utilization
         metadata:
           value: "70"
       - type: prometheus
         metadata:
           serverAddress: http://kps-prometheus.monitoring.svc:9090
           query: max(ai_forecast_replicas_needed{service="comment-service", horizon="15m"})
           threshold: "1"
           ignoreNullValues: "true"
   ```

   ```bash
   kubectl apply -f monitoring/keda/scaledobjects.yaml
   kubectl get scaledobject,hpa -n blog
   ```

   How the forecast trigger works: KEDA's Prometheus trigger uses an `AverageValue` target, so desired replicas = query value ÷ threshold. With `threshold: "1"`, the deployment asks for exactly `ai_forecast_replicas_needed` replicas.

**Checkpoint:** each ScaledObject shows `READY True`, `kubectl get hpa -n blog` lists three `keda-hpa-*` HPAs, and `kubectl describe hpa keda-hpa-post-service -n blog` shows both a cpu and an external metric with current values.

---

## 28. Step 25: Pre-scale nodes with Karpenter

Pre-scaled pods only help if there is room for them. [Karpenter](https://karpenter.sh/) launches EC2 nodes within about a minute when pods are `Pending`. To start nodes *before* the peak, you run low-priority **placeholder pods** sized like the app pods. KEDA scales the placeholders to the number of extra replicas the 1-hour forecast needs. When the real pods arrive, they evict the placeholders (lower priority), the placeholders become `Pending`, and Karpenter adds a node for them.

> Karpenter's installation changes between versions. The commands below follow the official "Migrating from Cluster Autoscaler" guide for an existing eksctl cluster. Check them against https://karpenter.sh/docs/getting-started/migrating-from-cas/ for the version you install; where they differ, the official guide wins.

1. Pick the version from https://github.com/aws/karpenter-provider-aws/releases and set:

   ```bash
   export KARPENTER_VERSION=<X.Y.Z>     # without the leading "v"
   export KARPENTER_NAMESPACE=kube-system
   ```

2. Create the node role, controller policy and interruption queue with the official CloudFormation template:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/aws/karpenter-provider-aws/v${KARPENTER_VERSION}/website/content/en/preview/getting-started/getting-started-with-karpenter/cloudformation.yaml \
     -o karpenter-cfn.yaml
   aws cloudformation deploy --region $AWS_REGION \
     --stack-name Karpenter-${CLUSTER_NAME} \
     --template-file karpenter-cfn.yaml \
     --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides ClusterName=${CLUSTER_NAME}
   ```

3. Let nodes with the Karpenter node role join the cluster:

   ```bash
   aws eks create-access-entry --region $AWS_REGION --cluster-name $CLUSTER_NAME \
     --principal-arn arn:aws:iam::${AWS_ACCOUNT_ID}:role/KarpenterNodeRole-${CLUSTER_NAME} \
     --type EC2_LINUX
   ```

   If this fails with an authentication-mode error, switch the cluster to `API_AND_CONFIG_MAP` first: `aws eks update-cluster-config --name $CLUSTER_NAME --region $AWS_REGION --access-config authenticationMode=API_AND_CONFIG_MAP`.

4. Create the controller's IAM role:

   ```bash
   eksctl create iamserviceaccount --cluster $CLUSTER_NAME --region $AWS_REGION \
     --namespace $KARPENTER_NAMESPACE --name karpenter \
     --role-name KarpenterControllerRole-${CLUSTER_NAME} \
     --attach-policy-arn arn:aws:iam::${AWS_ACCOUNT_ID}:policy/KarpenterControllerPolicy-${CLUSTER_NAME} \
     --role-only --approve
   ```

5. Tag the node subnets and the cluster security group so Karpenter knows where to launch nodes:

   ```bash
   NODEGROUP_SUBNETS=$(aws eks describe-nodegroup --region $AWS_REGION --cluster-name $CLUSTER_NAME \
     --nodegroup-name blog-workers --query 'nodegroup.subnets' --output text)
   CLUSTER_SG=$(aws eks describe-cluster --region $AWS_REGION --name $CLUSTER_NAME \
     --query 'cluster.resourcesVpcConfig.clusterSecurityGroupId' --output text)
   aws ec2 create-tags --region $AWS_REGION --resources $NODEGROUP_SUBNETS $CLUSTER_SG \
     --tags Key=karpenter.sh/discovery,Value=$CLUSTER_NAME
   ```

6. Install Karpenter:

   ```bash
   helm upgrade --install karpenter oci://public.ecr.aws/karpenter/karpenter \
     --version "${KARPENTER_VERSION}" --namespace $KARPENTER_NAMESPACE \
     --set "settings.clusterName=${CLUSTER_NAME}" \
     --set "settings.interruptionQueue=${CLUSTER_NAME}" \
     --set "serviceAccount.annotations.eks\.amazonaws\.com/role-arn=arn:aws:iam::${AWS_ACCOUNT_ID}:role/KarpenterControllerRole-${CLUSTER_NAME}" \
     --set controller.resources.requests.cpu=200m \
     --set controller.resources.requests.memory=256Mi \
     --wait
   ```

7. Tell Karpenter which nodes it may create. Create `monitoring/karpenter/nodepool.yaml` (replace `<CLUSTER_NAME>`):

   ```yaml
   apiVersion: karpenter.sh/v1
   kind: NodePool
   metadata:
     name: default
   spec:
     template:
       spec:
         nodeClassRef:
           group: karpenter.k8s.aws
           kind: EC2NodeClass
           name: default
         requirements:
           - key: node.kubernetes.io/instance-type
             operator: In
             values: ["t3.medium", "t3.large"]
           - key: karpenter.sh/capacity-type
             operator: In
             values: ["on-demand"]
           # Same zone as the managed node group (and its EBS volumes)
           - key: topology.kubernetes.io/zone
             operator: In
             values: ["ap-south-1a"]
     # Upper bound on what Karpenter may add, to cap cost
     limits:
       cpu: "8"
       memory: 32Gi
     disruption:
       consolidationPolicy: WhenEmptyOrUnderutilized
       consolidateAfter: 10m
   ---
   apiVersion: karpenter.k8s.aws/v1
   kind: EC2NodeClass
   metadata:
     name: default
   spec:
     role: KarpenterNodeRole-<CLUSTER_NAME>
     amiSelectorTerms:
       - alias: al2023@latest
     subnetSelectorTerms:
       - tags:
           karpenter.sh/discovery: <CLUSTER_NAME>
     securityGroupSelectorTerms:
       - tags:
           karpenter.sh/discovery: <CLUSTER_NAME>
   ```

   ```bash
   sed "s|<CLUSTER_NAME>|$CLUSTER_NAME|g" monitoring/karpenter/nodepool.yaml | kubectl apply -f -
   kubectl get nodepool,ec2nodeclass
   ```

8. Create the placeholder pods. Create `monitoring/keda/placeholder.yaml`:

   ```yaml
   # Lower than every real pod, so real pods always evict placeholders.
   apiVersion: scheduling.k8s.io/v1
   kind: PriorityClass
   metadata:
     name: capacity-placeholder
   value: -10
   preemptionPolicy: Never
   globalDefault: false
   description: "Placeholder pods that reserve room for forecast traffic"
   ---
   apiVersion: v1
   kind: Namespace
   metadata:
     name: capacity
   ---
   apiVersion: apps/v1
   kind: Deployment
   metadata:
     name: capacity-placeholder
     namespace: capacity
   spec:
     replicas: 0
     selector:
       matchLabels:
         app: capacity-placeholder
     template:
       metadata:
         labels:
           app: capacity-placeholder
       spec:
         priorityClassName: capacity-placeholder
         terminationGracePeriodSeconds: 0
         containers:
           - name: pause
             image: registry.k8s.io/pause:3.10
             # The same size as one app pod's request
             resources:
               requests:
                 cpu: 100m
                 memory: 128Mi
   ---
   # One placeholder for every replica the 1-hour forecast needs beyond what runs now.
   apiVersion: keda.sh/v1alpha1
   kind: ScaledObject
   metadata:
     name: capacity-placeholder
     namespace: capacity
   spec:
     scaleTargetRef:
       name: capacity-placeholder
     minReplicaCount: 0
     maxReplicaCount: 9
     triggers:
       - type: prometheus
         metadata:
           serverAddress: http://kps-prometheus.monitoring.svc:9090
           query: |
             sum(
               clamp_min(
                 max by (service) (ai_forecast_replicas_needed{horizon="1h"})
                 - on(service)
                 max by (service) (label_replace(kube_deployment_spec_replicas{namespace="blog"}, "service", "$1", "deployment", "(.*)")),
                 0
               )
             ) or vector(0)
           threshold: "1"
   ```

   ```bash
   kubectl apply -f monitoring/keda/placeholder.yaml
   ```

9. Test Karpenter by asking for more placeholders than fit:

   ```bash
   kubectl scale deployment/capacity-placeholder -n capacity --replicas=9
   kubectl get pods -n capacity -w        # some Pending, then Running on a new node
   kubectl get nodes -L karpenter.sh/nodepool
   kubectl logs -n kube-system -l app.kubernetes.io/name=karpenter --tail=30
   ```

   KEDA scales it back down within a minute or two, and Karpenter removes the empty node after `consolidateAfter` (10 minutes).

**Checkpoint:** during the test a node with the label `karpenter.sh/nodepool=default` joins the cluster, and it is removed again about 10 minutes after the placeholders scale back to 0.

---

## 29. Step 26: Build the AI Monitoring dashboard

In Grafana, **Dashboards → New → New dashboard**. Add a variable first: **Settings → Variables → New**, name `service`, type *Query*, query `label_values(service:http_requests:rate5m, service)`, *Multi-value* on. Then add these panels:

| Row | Panel | Type | Query (PromQL) |
|-----|-------|------|----------------|
| Anomaly detection | Traffic vs learned baseline | Time series | A: `service:http_requests:rate5m{service=~"$service"}` B: `ai_anomaly_baseline{signal="traffic", service=~"$service"}` |
| | p95 latency vs baseline | Time series | A: `service:http_latency_p95:5m{service=~"$service"}` B: `ai_anomaly_baseline{signal="latency_p95", service=~"$service"}` |
| | Anomaly scores | Time series, thresholds at -4 and 4 | `ai_anomaly_score{service=~"$service"}` |
| | Multi-signal outlier score | Time series, threshold at 0 | `ai_anomaly_outlier_score{service=~"$service"}` |
| | Firing anomaly alerts | Table | `ALERTS{alertstate="firing", detector=~"ml\|statistical"}` |
| Forecast | Actual vs 1h forecast peak | Time series | A: `service:http_requests:rate5m{service=~"$service"}` B: `ai_forecast_requests_per_second{horizon="1h", service=~"$service"}` |
| | 7-day forecast peak vs capacity | Bar gauge | A: `ai_forecast_requests_per_second{horizon="7d"}` B: `ai_forecast_capacity_rps` |
| | Replicas: needed (15m) vs running | Time series | A: `ai_forecast_replicas_needed{horizon="15m", service=~"$service"}` B: `kube_deployment_status_replicas{namespace="blog", deployment=~"$service"}` |
| | Placeholder pods | Stat | `kube_deployment_status_replicas{namespace="capacity"}` |
| | Nodes by pool | Stat | `count by (label_karpenter_sh_nodepool) (kube_node_labels)` (needs `kube-state-metrics.metricLabelsAllowlist` to include `nodes=[karpenter.sh/nodepool]`) |
| Capacity | Days until PVC full | Stat | `kubelet_volume_stats_available_bytes / clamp_min(-deriv(kubelet_volume_stats_available_bytes[6h]), 1) / 86400` |
| | Cluster CPU requested vs allocatable | Time series | A: `sum(kube_pod_container_resource_requests{resource="cpu"})` B: `sum(kube_node_status_allocatable{resource="cpu"})` |

To keep the dashboard in Git: **Share → Export → Save to file**, store the JSON as `monitoring/dashboards/ai-monitoring.json`, then load it through the Grafana sidecar (which kube-prometheus-stack enables by default):

```bash
kubectl create configmap ai-monitoring-dashboard -n monitoring \
  --from-file=ai-monitoring.json=monitoring/dashboards/ai-monitoring.json
kubectl label configmap ai-monitoring-dashboard -n monitoring grafana_dashboard=1
```

**Checkpoint:** the dashboard shows the actual traffic line following the learned baseline, anomaly scores mostly between -2 and 2, and the forecast line close to the actual one.

---

# Reference

## 30. Summary of everything you created

| Where | What |
|-------|------|
| AWS | EBS CSI driver add-on and IAM role; 3 PVCs (Prometheus 20 GiB, Grafana 5 GiB, Alertmanager 2 GiB); ECR repos `blog-anomaly-detector`, `blog-alert-summarizer`, `blog-capacity-forecaster`; Karpenter CloudFormation stack, IAM roles and SQS queue |
| `kube-system` | `ebs-csi-*`, `karpenter` |
| `monitoring` | kube-prometheus-stack (`kps-*`), `anomaly-detector`, `alert-summarizer`, `capacity-forecaster`, ServiceMonitors, PrometheusRules, secrets `grafana-admin`, `alertmanager-gmail`, `alert-summarizer` |
| `keda` | KEDA operator |
| `capacity` | `capacity-placeholder` deployment and ScaledObject |
| `blog` | Services labelled `monitoring: enabled` with a named `http` port; ScaledObjects replacing the HPAs; `/metrics` in each service |
| `ingress-nginx` | `ingress-nginx-controller-metrics` Service |
| Cluster-wide | StorageClass `gp3`, PriorityClass `capacity-placeholder`, ClusterRole `alert-summarizer-read`, NodePool and EC2NodeClass `default` |

Metrics added by this guide:

| Metric | From | Meaning |
|--------|------|---------|
| `http_request_duration_seconds_*` | services | Request count and latency histogram |
| `service:http_requests:rate5m` | recording rule | Requests/s per service |
| `service:http_errors:ratio_rate5m` | recording rule | 5xx ratio per service |
| `service:http_latency_p95:5m` | recording rule | p95 latency per service |
| `ai_anomaly_score{signal}` | anomaly-detector | Robust z-score against this hour's baseline |
| `ai_anomaly_baseline{signal}` | anomaly-detector | Expected value this hour |
| `ai_anomaly_outlier_score` | anomaly-detector | Isolation Forest score, > 0 = unusual |
| `ai_forecast_requests_per_second{horizon}` | capacity-forecaster | Forecast peak req/s |
| `ai_forecast_replicas_needed{horizon}` | capacity-forecaster | Replicas needed for that peak |
| `ai_forecast_capacity_rps` | capacity-forecaster | req/s servable at max replicas |

---

## 31. Cost

| Item | Rough monthly cost |
|------|--------------------|
| EBS gp3, about 27 GiB | A few US dollars |
| Extra CPU and memory on existing nodes | None, if Step 1 found room |
| Karpenter nodes | Only while they run; one t3.medium on demand in ap-south-1 is a few cents per hour |
| Claude API (alert summaries) | Each summary sends roughly 5,000 to 20,000 input tokens. With `claude-opus-5-5` ($4 / $20 per million input / output tokens) that is a few cents per alert; `claude-haiku-5-5` is much cheaper. Keep `repeat_interval` at 4h or more, so a long-running alert is not re-summarized every few minutes. |

Check current prices at https://aws.amazon.com/ebs/pricing/, https://aws.amazon.com/ec2/pricing/on-demand/ and https://www.anthropic.com/pricing.

---

## 32. Troubleshooting

### Installation

| Symptom | Cause and fix |
|---------|---------------|
| PVCs stay `Pending` | The EBS CSI driver is missing or has no IAM role. `kubectl describe pvc -n monitoring` and `kubectl logs -n kube-system deploy/ebs-csi-controller -c csi-provisioner`. Redo Step 2. |
| Pods `Pending` with `Too many pods` | t3.medium allows 17 pods. Add a node (Step 1) or let Karpenter add one (Step 25). |
| Grafana pod stuck `ContainerCreating` after an upgrade, `Multi-Attach error` | The old pod still holds the volume. Make sure `deploymentStrategy.type: Recreate` is set, then delete the old pod. |
| `helm upgrade` says `UPGRADE FAILED: another operation is in progress` | `helm history kps -n monitoring`, then `helm rollback kps <last good revision> -n monitoring`. |

### Scraping and rules

| Symptom | Cause and fix |
|---------|---------------|
| `blog-services` target missing | The Service lacks the label `monitoring: enabled`, or the port is not named `http`. `kubectl get svc -n blog --show-labels`. |
| Target is `DOWN` with 404 | The running image does not have `/metrics` yet. Rebuild and redeploy the service (Step 7). |
| Rule state `err` in **Status → Rules** | Typo in the PromQL. Paste the expression into the Graph tab to see the error. |
| `ai_*` metrics carry `exported_service` instead of `service` | The `ai-monitoring` ServiceMonitor is missing `honorLabels: true`. |
| `ai_anomaly_score` is empty | Less than 1 day of data, or the recording rules are missing. Check the detector log for `trained 0 baselines`. |

### Alerts and email

| Symptom | Cause and fix |
|---------|---------------|
| No email at all | `kubectl logs -n monitoring alertmanager-kps-alertmanager-0 -c alertmanager`. `535` = wrong app password; `connection refused` = egress to smtp.gmail.com:587 blocked. |
| Email arrives without an AI summary | `kubectl logs -n monitoring deploy/alert-summarizer`. `401` = wrong `ANTHROPIC_API_KEY`; `429` = rate limit, the SDK retries twice and then the plain alert is sent; `403` from Kubernetes = the ClusterRoleBinding is missing. |
| AI summary says "no logs available" | The alert had no `pod` label and no pod has `app=<service>`. Check the alert's labels in Alertmanager. |
| Too many anomaly emails | Raise thresholds or `for:` durations (Step 16). Check that the load generator (Step 12) or real traffic has been steady for at least a week. |

### Scaling

| Symptom | Cause and fix |
|---------|---------------|
| ScaledObject `READY False`, "HPA already exists" | An old HPA still targets the deployment. `kubectl get hpa -n blog` and delete the non-`keda-hpa-*` one. |
| KEDA external metric shows `<unknown>` | The forecast does not exist yet (needs 2 days of data), or the query is wrong. Run the ScaledObject's query in Prometheus. |
| Placeholders `Pending` but no new node | `kubectl logs -n kube-system -l app.kubernetes.io/name=karpenter`. Usually missing `karpenter.sh/discovery` tags, the access entry, or the NodePool `limits` were reached. |
| New Karpenter node never becomes `Ready` | The node role has no access entry (Step 25.3), or the subnets have no route to the internet / ECR. |

### Useful commands

```bash
# Everything in the monitoring namespace
kubectl get pods,svc,pvc,servicemonitor,prometheusrule -n monitoring

# Which alerts are firing right now
kubectl port-forward -n monitoring svc/kps-alertmanager 9093:9093   # then http://localhost:9093

# Logs of the AI services
kubectl logs -n monitoring deploy/anomaly-detector --tail=50
kubectl logs -n monitoring deploy/alert-summarizer --tail=50
kubectl logs -n monitoring deploy/capacity-forecaster --tail=50

# Scaling decisions
kubectl get scaledobject,hpa -n blog
kubectl describe hpa keda-hpa-post-service -n blog
```

---

## 33. Clean up

Remove in reverse order. Deleting PVCs deletes the collected metrics history.

```bash
# Part 4
kubectl delete -f monitoring/keda/placeholder.yaml
kubectl delete -f monitoring/keda/scaledobjects.yaml
# Restore the CPU HPAs (rename hpa.yaml.disabled back to hpa.yaml first)
for s in auth-service post-service comment-service; do kubectl apply -f k8s/$s/hpa.yaml; done
kubectl delete nodepool default; kubectl delete ec2nodeclass default   # Karpenter removes its nodes
helm uninstall karpenter -n kube-system
aws cloudformation delete-stack --stack-name Karpenter-${CLUSTER_NAME} --region $AWS_REGION
eksctl delete iamserviceaccount --cluster $CLUSTER_NAME --region $AWS_REGION --namespace kube-system --name karpenter
helm uninstall keda -n keda && kubectl delete namespace keda

# Parts 2 and 3
kubectl delete deploy,svc anomaly-detector alert-summarizer capacity-forecaster -n monitoring
kubectl delete clusterrolebinding,clusterrole alert-summarizer-read
kubectl delete -f monitoring/rules/

# Part 1
helm uninstall kps -n monitoring
kubectl delete pvc --all -n monitoring
kubectl delete namespace monitoring
# The chart leaves its CRDs behind on purpose; remove them only if nothing else uses them
kubectl get crd -o name | grep monitoring.coreos.com | xargs kubectl delete

# ECR repositories
for r in blog-anomaly-detector blog-alert-summarizer blog-capacity-forecaster; do
  aws ecr delete-repository --repository-name $r --region $AWS_REGION --force
done
```

To remove the EBS CSI driver as well: `eksctl delete addon --cluster $CLUSTER_NAME --region $AWS_REGION --name aws-ebs-csi-driver`.
