# kubernetes-aws-metadata-service

Service that adds annotations for the [AWS availability zone name and id](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-regions-availability-zones.html) to pods scheduled onto AWS instances.

| Annotation                               | Example value
|------------------------------------------|--------------
| `ec2.amazonaws.com/availability-zone`    | `eu-west-1a`
| `ec2.amazonaws.com/availability-zone-id` | `euw1-az3`

These annotations can be used in environment variables or downward API volumes.

## Security/Permissions

* The service needs the `ec2:DescribeAvailabilityZones` IAM permission to be able to lookup the availability zone ids.
  In the example below that is provisioned through kube2iam, but any other means of providing the permission is acceptable.
* The service needs to be able to `LIST`, `WATCH`, `GET` and `PATCH` pods in the selected namespace
* The service needs to be able to `GET` nodes from the Kubernetes cluster

## Usage

The service is watches a single namespace; for watching multiple namespaces it should be deployed multiple times. It is safe to deploy more than one instance, as the behavior of the service is idempotent.

_Note: `NAMESPACE` refers to the namespace where the service is deployed, and `ROLE` refers to the ARN of the AWS IAM role._

```yaml
kind: ClusterRole
apiVersion: rbac.authorization.k8s.io/v1
metadata:
  name: aws-metadata-service-global
rules:
- apiGroups:
  - ""
  resources:
  - nodes
  verbs:
  - get
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: aws-metadata-service
rules:
- apiGroups:
  - ""
  resources:
  - pods
  verbs:
  - get
  - patch
  - list
  - watch
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: aws-metadata-service
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: aws-metadata-service
roleRef:
  kind: Role
  name: aws-metadata-service
  apiGroup: rbac.authorization.k8s.io
subjects:
- kind: ServiceAccount
  name: aws-metadata-service
  namespace: NAMESPACE
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: aws-metadata-service-global-NAMESPACE
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: aws-metadata-service-global
subjects:
- kind: ServiceAccount
  name: aws-metadata-service
  namespace: NAMESPACE
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: aws-metadata-service
spec:
  replicas: 1
  revisionHistoryLimit: 10
  selector:
    matchLabels:
      service: aws-metadata-service
  template:
    metadata:
      labels:
        service: aws-metadata-service
      annotations:
        iam.amazonaws.com/role: ROLE_ARN
        prometheus.io/scrape: 'true'
        prometheus.io/port: '8080'
    spec:
      serviceAccountName: aws-metadata-service
      volumes:
      - name: aws
        configMap:
          name: aws
          items:
          - key: aws.config
            path: config
          - key: aws.credentials
            path: credentials
      containers:
      - name: aws-metadata-service
        image: docker.io/collaborne/kubernetes-aws-metadata-service:latest
        imagePullPolicy: Always
        args:
        - --namespace=$(POD_NAMESPACE)
        env:
        - name: AWS_REGION
          value: eu-west-1
        - name: POD_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
        ports:
        - name: http
          containerPort: 8080
          protocol: TCP
        readinessProbe:
          httpGet:
            path: /metrics
            port: http
          initialDelaySeconds: 5
          periodSeconds: 5
        volumeMounts:
        - name: aws
          readOnly: true
          mountPath: /root/.aws

```

## License

This project is licensed under the Apache 2.0 License, see [LICENSE](blob/master/LICENSE) for the full text.

Copyright (c) 2020 Collaborne B.V.