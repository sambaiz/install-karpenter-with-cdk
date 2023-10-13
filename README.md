## install-karpenter-with-cdk 

- ja: [CDK で EKS クラスタに Karpenter をインストールし柔軟で高速なオートスケールを行う - sambaiz-net](https://www.sambaiz.net/article/455/)
- en: [Install Karpenter on an EKS cluster with CDK to auto-scale flexibility and quickly - sambaiz-net](https://www.sambaiz.net/en/article/455/)

### Launch an EKS cluster with Karpenter

```sh
export KARPENTER_VERSION="v0.31.0" 
curl -o karpenter_${KARPENTER_VERSION}.yaml  https://raw.githubusercontent.com/aws/karpenter/"${KARPENTER_VERSION}"/website/content/en/preview/getting-started/getting-started-with-karpenter/cloudformation.yaml

npm run build
npm run cdk deploy

aws eks update-kubeconfig --name karpenter-test --region us-east-1 --role-arn <masters_role_arn> 
```

### Try to scale a deployment 

```sh
cat <<EOF | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: inflate
spec:
  replicas: 0
  selector:
    matchLabels:
      app: inflate
  template:
    metadata:
      labels:
        app: inflate
    spec:
      terminationGracePeriodSeconds: 0
      containers:
        - name: inflate
          image: public.ecr.aws/eks-distro/kubernetes/pause:3.7
          resources:
            requests:
              cpu: 1
EOF
kubectl scale deployment inflate --replicas 5
kubectl logs -f -n karpenter -l app.kubernetes.io/name=karpenter -c controller
```

### Clean up

```sh
npm run cdk destroy KarpenterTestStack
```
