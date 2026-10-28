# GCP application copy

This directory contains a GCP-local copy of the application source needed to build the four container images. It is intentionally separate from the repository-root application and AWS deployment files.

- `services/auth-service`, `services/post-service`, and `services/comment-service` are the Node.js/Prisma API services.
- `frontend` is the React/Vite application plus its NGINX container configuration.
- Kubernetes deployment files for GCP live separately in `gcp/k8s/`.

The frontend `.env.production` sets `VITE_API_URL` to an empty value so browser requests use same-origin `/api/...` paths routed by the GCP NGINX Ingress. No AWS domain is embedded in this copy.

These are source copies, not automatically synchronized with the repository-root services. For the GCP track, make future application changes in this directory or deliberately copy and review them here before building GCP images. Do not edit root/AWS files as part of GCP-only changes.
